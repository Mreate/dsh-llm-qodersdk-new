# dsh-llm-qodersdk

> **中文** | [English](README.en.md)

将 DeepSeek Harness 的 LLM 接缝（`ctx.llm`）路由到本机 **Qoder CLI** 的适配器插件（`@jiamingzang/dsh-llm-qoder`），基于 [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk)。

它注册 `qoder` / `qoder-byok` 两个 provider 路由，让 harness 的模型请求复用本机 `qodercli` 的登录态——**无需任何凭据或设置项**。模型与账号自定义模型都从 qodercli 实时拉取。

## 特性

- **无配置接入**：完全复用本机 `qodercli` 登录态，不需要 API key 或 settings 段。
- **双路由**：`qoder` 广告账号内置模型；`qoder-byok` 只广告账号自定义模型（各自独立路由）。
- **长驻会话**：每个宿主 session id 对应一个 warm 内层 `query()` 子进程，对话延续、工具轮次都发生在会话内部；`maxSessions` 上限内按插入序 LRU 淘汰。
- **工具桥接**：宿主工具通过进程内 MCP server（`dsh-host`）暴露给内层模型；qodercli 一次执行一个调用、宿主一次回传整轮结果，二者通过 callId 配对（120s 内未回传则超时取消）。
- **模型目录**：实时从 CLI 拉取可用模型（含账号自定义模型），TTL 缓存 + 并发共享 + 超时保护，失败回退静态目录；另提供 `deepseek-v4-flash` → `dfmodel`、`deepseek-v4-pro` → `dmodel` 别名。
- **思考强度与上下文窗口**：`resolveModel` 上报 CLI 的 reasoning efforts、默认档位与 `availableContextWindows` / `defaultContextWindow`，模型选择器可直接切换；所选值随每次请求下发。
- **旁路请求**：标题生成、compaction 等 side-channel 请求走冷启动一次性调用，不占用 warm 会话。
- **溢出可恢复**：内层模型因上下文超限失败时（如 `maximum context length ... you requested N tokens`），按 dsh-llm 的 `isContextWindowExceededError` 分类为 `CONTEXT_WINDOW_EXCEEDED` 上报，harness 的溢出自动恢复（配合 `compaction-basic`）可以接管而不是让轮次直接报废。

## 适配原理

这一节说明本插件把 harness 的 LLM 接缝映射到 qodercli 时，**每一层是怎么适配的、为什么这么设计**。

### 1. LLM 接缝适配（`ctx.llm` → qodercli）

harness 通过 `ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)` 注册 `QoderAdapter`，实现 harness 的 `LlmAdapter` 契约：

| harness 接缝 | 本插件实现 |
| --- | --- |
| `providerInfo(provider)` | 返回 `qoder`（Qoder CLI）/ `qoder-byok`（Qoder 自定义）的展示名 |
| `listModels(provider)` | 实时拉取 qodercli 模型目录，按 provider 过滤（`qoder` 出内置、`qoder-byok` 出账号自定义 `source === 'user'`） |
| `resolveModel(provider, model)` | 从 live catalog / 静态表解析模型元数据（上下文窗口、思考档位、输出上限） |
| `stream(options)` | 把一次 `GenerateOptions` 转成 qodercli 的 `query()` 调用并流式回传 `StreamChunk` |

适配的核心是 **`stream()` 的分流**：

- **warm 会话路径**（有 `sessionId` 且无 `purpose`）：复用或新建一个内层 `query()` 子进程，增量喂入新消息，工具通过 MCP 往返。
- **side-channel 路径**（无 `sessionId`，或带 `purpose`，如标题生成、compaction 摘要）：走 `coldStream()` 一次性调用，不占 warm 会话。**该路径复用主会话的模型**（`resolveQoderModelId(options.model)`），保证 dsh 记录的调用目标与实际执行的模型一致。

### 2. 会话模型适配

- **一宿主会话对应一 warm qodercli 会话**：`QoderSessionManager` 以宿主 `sessionId` 为键维护 `query()` 子进程，超出 `maxSessions` 按插入序 LRU 淘汰。
- **增量 feed**：宿主每次请求携带完整消息列表，插件通过 `planContinuation` 对比上一次，只把新用户轮次与改写消息渲染成纯文本 feed；工具结果不进入文本 feed（走 MCP）。
- **重建检测**：当宿主 surface 被改写（例如 compaction 折叠了历史）导致消息数变少或结构变化，`planContinuation` 返回 `rebuild: true`，插件 dispose 旧 warm 会话并按新 surface 冷启动。**这保证了 dsh 侧的压缩与 qodercli 内部缓存不会产生双份状态**。
- **模型切换**：`setModel` 把 `reasoningEffort` / `contextWindow` 作为 model-policy 参数传给内层会话。

### 3. 工具桥接适配（MCP）

宿主工具不直接发给 qodercli，而是通过**进程内 MCP server**（`dsh-host`）：

1. `ensureTools()` 把宿主 `ToolSchema` 转成 zod shape 注册到 MCP server；
2. qodercli 的 `canUseTool` 允许 `mcp__dsh-host__*` 前缀的工具，并记录 tool-use id；
3. MCP handler **park** 在一个 promise 上，等待宿主在下一轮请求里 `deliverToolResults()` 回传结果；
4. 结果按 `callId ↔ toolUseId` 配对投递；超时（`TOOL_RESULT_TIMEOUT_MS`）则返回错误让 qodercli 恢复。

这样宿主工具调用是**宿主侧的普通工具轮次**，qodercli 只看到 MCP 工具被"执行了一次"。

### 4. 模型目录适配

- **实时目录**：`QoderModelCatalog` 向 qodercli 发 `get_models` 控制请求，TTL 缓存（默认 300s）、并发共享、超时回退静态表。
- **静态回退**：`QODER_MODELS` 内置捕获的模型表（含 `deepseek-v4-flash` / `deepseek-v4-pro` 别名），CLI 不可达时使用。
- **provider 分组**：`listModels` 按 `source` 字段分流——内置模型进 `qoder`，账号自定义模型（`source === 'user'`）进 `qoder-byok`，无需任何手动配置，全部从 qodercli 实时拉取。

### 5. 上下文窗口与压缩阈值的适配

qodercli 的 live catalog 对每个模型同时上报**上限**与**实际窗口**：

```
maxInputTokens: 1000000          ← 模型上限（1M）
availableContextWindows: [200000, 400000, 1000000]
defaultContextWindow: 200000     ← 请求实际使用的窗口
```

harness 的 compaction 引擎用 `resolveModel().context.contextWindow` 计算自动压缩阈值（`thresholdTokens = 0.8 × contextWindow`，compaction-basic 默认 `thresholdRatio: 0.8`），UI 上下文环也以它为分母。因此 `contextWindow` 必须反映**请求实际使用的窗口**，而不是模型上限：

```ts
contextWindow: live.defaultContextWindow ?? live.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW
```

- 取 `defaultContextWindow`（实际窗口，如 200K）→ 阈值 = 160K，与 provider 真实能力对齐；
- `maxInputTokens`（上限，如 1M）只保留在 `availableContextWindows` 里供选择器切换；
- 若误用上限，阈值会被放大（如 800K），压缩永远不会在 provider 拒绝前触发。

### 6. 上下文占用计量的适配

qodercli 的流事件 `usage` 帧（`input_tokens` / `output_tokens`）默认全零（无 metering 数据），因此无法直接上报真实用量。harness 的 `contextPressure` 投影以最近一次请求的 `inputTokens` 为分子（`pressureTokens`）驱动 UI 环与压缩判断。

适配方式：**在插件侧按 harness 前端 token-meter 相同的口径估算每次请求的输入**。

`adapter.stream()` 每次请求调用 `session.recordRequestInput(system, messages)`，用 `renderInitialFeed(system, messages)` 渲染完整会话（系统提示 + 全部消息），按 `rendered.length / 4` 估算 token —— 与 harness `estimate.ts` 的 `CHARS_PER_TOKEN = 4` 同口径。`usage()` 优先返回该估算值：

```ts
if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
  return { inputTokens: this.estimatedInputTokens, ... }
}
```

这样 UI 上下文环、自动压缩阈值与插件上报值**使用同一套估算口径**，占用显示与压缩行为一致，不会出现"UI 显示 2% 而实际已接近上限"的割裂。

### 7. 错误分类适配

qodercli 把上下文超限、配额不足等拒绝统一报成 generic per-turn error（`error_during_execution`）。harness 的 overflow recovery 依赖错误码 `CONTEXT_WINDOW_EXCEEDED` 才会触发（prune + compact + retry）。因此插件用 dsh-llm 的共享分类器把 qodercli 的报错文本映射成 harness 可路由的错误码：

```ts
function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}
```

这样 provider 的上下文超限能触发 harness 的自动恢复，配额不足能正确展示，而不是当作普通后端错误死掉。

### 8. 压缩职责分工（dsh vs qoder）

- **压缩由 dsh（harness compaction-basic）执行**：决定压缩范围、保留比例（默认 `retainRatio: 0.16` 保留最近 16%）、调用 LLM 生成 checkpoint、改写会话 surface。
- **qoder 插件只充当 LLM 后端**：把 dsh 的消息喂给 qodercli、取回回复。压缩摘要请求通过 side-channel 走 `coldStream()`，并复用主会话模型（见第 1 节），保证 dsh 记录的摘要目标与实际执行一致。
- **无冲突保证**：dsh 压缩改写 surface 后，插件 `planContinuation` 检测到消息结构变化（`rebuild: true`），主动重建 warm 会话。qodercli 内部缓存随 dsh 压缩被作废，**不存在"两边各压一遍"**。
- 摘要生成默认走主会话路由；需要绕开特定 provider 配额时，可在 `cordis.patch.yml` 给 compaction-basic 配置 `summarizationProvider` / `summarizationModel` 指向其它有额度的模型。

## 安装

前置条件：本机已安装并登录 qodercli（`qodercli --version` 可运行）。插件完全复用 qodercli 登录态，不需要 API key 或 settings 段。

### 从发布包引入

1. 获取插件包：本仓库 Releases 可能为空，直接在仓库根目录执行 `pnpm install && pnpm pack` 生成 `jiamingzang-dsh-llm-qoder-<version>.tgz`（`pnpm pack` 会先自动构建出 `lib/`）；
2. 添加到目标 profile：

   ```sh
   dsh plugin --profile <profile> add jiamingzang-dsh-llm-qoder-<version>.tgz
   ```

3. **首次安装需批准构建脚本**：`@qoder-ai/qoder-agent-sdk` 带 postinstall（下载 worker runtime），pnpm 11+ 默认拦截并报 `ERR_PNPM_IGNORED_BUILDS`。dsh 会把待批准 key 写入 profile 的 `pnpm-workspace.yaml` 占位（`allowBuilds` 下 `'@qoder-ai/qoder-agent-sdk': set this to true or false`），把值改为 `true` 后重跑上面的 add 命令即完成安装——这是 dsh 对任何带 postinstall 依赖的标准 fail-loud 流程；
4. 验证：`dsh --profile <profile> --dump-config | grep llm-qoder` 应出现插件条目；重启服务后模型选择器出现 `qoder` / `qoder-byok`。

### 手动挂载（可选）

不经过 plugin 命令时，可在 cordis.yml 或 patch 层直接声明（插件 package.json 也声明了 `dsh.bundle`，plugin add 后会自动进 profile 的 bundles）：

```yaml
- id: llm-qoder
  name: '@jiamingzang/dsh-llm-qoder'
```

### 使用与排障

- 在对话框模型选择器或 Models 设置页选择 `qoder`（账号内置）或 `qoder-byok`（账号自定义）下的模型；上下文窗口与思考档位可在模型面板切换。
- **看不到自定义模型或窗口调节消失**：多为 qodercli 自动升级窗口期或账号配额用尽（服务端把模型标 `isEnabled: false`）导致 live 目录拉取失败，插件回退静态目录。拉取失败不缓存，CLI 恢复后自动回来，无需重启服务。

## 配置

| 字段 | 类型 | 默认 | 说明 |
| --- | --- | --- | --- |
| `maxSessions` | number | `8` | 同时保持 warm 的内层 qodercli 会话上限（超出按插入序 LRU 淘汰） |
| `modelCacheTtlSeconds` | number | `300` | CLI 模型目录的缓存保鲜秒数 |

## 上下文管理与压缩

warm 内层会话会累积整段宿主历史：首轮喂入全量历史（`renderInitialFeed`），之后每轮只喂增量（新用户消息、原位刷新）。内层上下文因此随对话增长，模型有硬上限（如 1048576 tokens）。

- **溢出自动恢复**：内层模型报上下文超限时，插件上报 `CONTEXT_WINDOW_EXCEEDED`。harness 的溢出恢复（`dsh-compaction-basic` 的 `agent/request-error` 处理器）会压缩宿主历史并重试；压缩后宿主历史变短，下个请求插件检测到历史回退，自动重建内层会话、冷喂压缩后的历史。
- **前提**：部署里必须加载 `dsh-compaction-basic`（`auto` 默认 `true`）和 `dsh-token-meter`。没装压缩插件时，超限轮次仍会失败——只能新开会话或手动压缩。
- **建议把压力阈值调低**：默认 `thresholdRatio` 0.8 × 模型 contextWindow（1048576 → 约 838k）可能偏晚，尤其宿主侧 token 估算与内层真实用量有偏差时。建议调低到 0.6，让压力压缩远早于溢出触发：

  ```yaml
  - id: compaction-basic
    config:
      auto: true
      thresholdRatio: 0.6
      retainRatio: 0.16
  ```

  也可用 `modelPolicies` 给 `qoder` 路由单独配置。
- **手动压缩**：加载 `dsh-command-compact` 后，对话中输入 `/compact` 立即压缩一次。
- **已超限的会话**：历史已经超过模型上限时，"继续"只会带着更长历史重试失败；先 `/compact` 压缩（或调低阈值后等压力压缩触发），否则新开会话。

## 源码结构

| 文件 | 职责 |
| --- | --- |
| `src/index.ts` | 插件入口：`ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)` |
| `src/adapter.ts` | `QoderAdapter`：模型列表/解析/流式生成，warm 会话管理、续轮规划、side-channel 模型传递、请求输入估算 |
| `src/session.ts` | `QoderSession`：内层 `query()` 子进程、MCP 工具桥、SDK 流事件 → harness `StreamChunk`、usage 上报（真实输入估算 + 错误分类） |
| `src/models.ts` | 实时模型目录拉取（TTL 缓存、并发共享、超时、静态回退） |
| `src/catalog.ts` | 静态模型表与 `deepseek-v4-*` 别名 |
| `src/render.ts` | 宿主消息 → 内层纯文本 feed；身份覆盖 |
| `src/jsonschema.ts` | dsh `ToolSchema.parameters` → zod shape（MCP 工具注册用） |

## 开发与构建

本仓库**提交构建产物** `lib/`（`lib/index.js` + `lib/types/*.d.ts`），源码只有 `src/` 与测试 `tests/`。

为什么把产物入库：pnpm 在准备 git 依赖时，只要发现有 `prepare` 这类**安装期**脚本，就要求使用方在 `allowBuilds` 里放行，而该放行键是「包名@解析后的 tarball URL」，带 commit hash、每次推送都会变。产物入库 + 安装期无脚本之后，`github:` 安装不需要任何额外放行（只剩 `@qoder-ai/qoder-agent-sdk` 那条按包名的构建批准）。

所以本包**没有** `prepare`，构建挂在 `prepack` 上（只在 pack / publish 时运行）：

```sh
pnpm install     # 只装依赖，不会构建
pnpm run build   # 手动构建：tsc 产出 lib/types/*.d.ts，tsdown 产出 lib/index.js
pnpm test        # vitest 单元测试
pnpm pack        # prepack 自动先构建，再生成 jiamingzang-dsh-llm-qoder-<version>.tgz
pnpm publish     # prepack 自动先构建
```

> 改动 `src/` 后记得 `pnpm run build` 并把 `lib/` 一并提交，否则 git 安装拿到的是旧产物。

构建配置已就位（`tsconfig.json` + `tsdown.config.ts`），peer 依赖 `@deepseek-ai/dsh-llm`、`@deepseek-ai/cordis`、`@deepseek-ai/schemastery` 保持 external——这三者由 harness 运行时的 shared package 提供，不会装进 profile。

> **版本说明**：插件面向 DeepSeek Harness **0.1.7-rc.2**（desktop profile 的当前运行时）。peer 范围为 `@deepseek-ai/dsh-llm@^0.1.7-rc.2`，编译对齐运行时 sharedPackages 的 `@deepseek-ai/cordis@4.0.4` + `@deepseek-ai/schemastery@3.18.4`。0.1.7 的 settings seam 已改为「按 profile entry id 投影插件 Config 表单」，插件不再注册 settings 命名空间，也不再依赖 `@deepseek-ai/dsh-settings`。

## License

[MIT](LICENSE) © 2026 dsh-llm-qodersdk contributors
