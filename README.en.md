# dsh-llm-qodersdk

> **中文** | [English](README.en.md)

An adapter plugin (`@mreate/dsh-llm-qoder`) that routes DeepSeek Harness's LLM seam (`ctx.llm`) to the local **Qoder CLI**, built on [`@qoder-ai/qoder-agent-sdk`](https://www.npmjs.com/package/@qoder-ai/qoder-agent-sdk).

It registers the `qoder` / `qoder-byok` provider routes so the harness's model requests reuse the local `qodercli` login state — **no credentials or settings required**. Both built-in models and account-custom models are fetched live from qodercli.

## Features

- **Zero-config**: fully reuses the local `qodercli` login state; no API key or settings section needed.
- **Two routes**: `qoder` advertises built-in account models; `qoder-byok` advertises only account-custom models (each with its own independent route).
- **Persistent sessions**: one warm inner `query()` subprocess per host session id; conversation continuation and tool rounds all happen inside the session, LRU-evicted by insertion order within the `maxSessions` cap.
- **Tool bridging**: host tools are exposed to the inner model through an in-process MCP server (`dsh-host`); qodercli executes one call at a time and the host returns the whole round of results, paired by callId (timed out and cancelled if not delivered within 120s).
- **Model catalog**: fetches available models (including account-custom ones) live from the CLI with TTL caching + shared concurrency + timeout protection, falling back to a static catalog on failure; also provides `deepseek-v4-flash` → `dfmodel` and `deepseek-v4-pro` → `dmodel` aliases.
- **Reasoning effort & context window**: `resolveModel` reports the CLI's reasoning efforts, default level, and `availableContextWindows` / `defaultContextWindow` so the model selector can switch them; the selected values are sent per-request via the model-policy parameter.
- **Side-channel requests**: titles, compaction summaries, and other side-channel requests use one-shot cold calls that never occupy a warm session.
- **Overflow recoverable**: when the inner model fails on context overflow (e.g. `maximum context length ... you requested N tokens`), the error is classified as `CONTEXT_WINDOW_EXCEEDED` via dsh-llm's `isContextWindowExceededError`, so the harness's overflow auto-recovery (with `compaction-basic`) takes over instead of wasting the turn.

## Adaptation Principles

This section explains how the plugin maps the harness's LLM seam to qodercli — **what each layer adapts and why it is designed that way**.

### 1. LLM seam adaptation (`ctx.llm` → qodercli)

The harness registers `QoderAdapter` via `ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)`, implementing the harness's `LlmAdapter` contract:

| Harness seam | This plugin's implementation |
| --- | --- |
| `providerInfo(provider)` | Returns display names for `qoder` (Qoder CLI) / `qoder-byok` (Qoder custom) |
| `listModels(provider)` | Fetches the qodercli model catalog live, filtered by provider (`qoder` → built-in; `qoder-byok` → account-custom `source === 'user'`) |
| `resolveModel(provider, model)` | Resolves model metadata (context window, reasoning effort, output limit) from the live catalog / static table |
| `stream(options)` | Turns a `GenerateOptions` into a qodercli `query()` call and streams back `StreamChunk` |

The core of the adaptation is **`stream()` routing**:

- **Warm session path** (has `sessionId` and no `purpose`): reuse or spawn an inner `query()` subprocess, feed new messages incrementally, and round-trip tools over MCP.
- **Side-channel path** (no `sessionId`, or carries `purpose`, e.g. title generation, compaction summaries): one-shot `coldStream()` call that does not occupy a warm session. **This path reuses the main session's model** (`resolveQoderModelId(options.model)`), so the call target dsh records matches the model actually executed.

### 2. Session model adaptation

- **One host session ↔ one warm qodercli session**: `QoderSessionManager` keys `query()` subprocesses by host `sessionId`; beyond `maxSessions` they are evicted LRU by insertion order.
- **Incremental feed**: the host sends the full message list on every request; the plugin uses `planContinuation` to diff against the previous one and renders only the new user turns and rewritten messages into a plain-text feed; tool results never enter the text feed (they go over MCP).
- **Rebuild detection**: when the host surface is rewritten (e.g. compaction folds history) so messages shrink or restructure, `planContinuation` returns `rebuild: true` and the plugin disposes the old warm session and cold-starts from the new surface. **This guarantees dsh-side compaction and qodercli's internal cache never hold duplicate state.**
- **Model switching**: `setModel` forwards `reasoningEffort` / `contextWindow` to the inner session as model-policy parameters.

### 3. Tool bridging adaptation (MCP)

Host tools are not sent directly to qodercli; they go through an **in-process MCP server** (`dsh-host`):

1. `ensureTools()` converts host `ToolSchema` to zod shapes and registers them on the MCP server;
2. qodercli's `canUseTool` allows tools with the `mcp__dsh-host__*` prefix and records tool-use ids;
3. the MCP handler **parks** on a promise, waiting for the host to deliver results via `deliverToolResults()` in the next request round;
4. results are paired by `callId ↔ toolUseId`; on timeout (`TOOL_RESULT_TIMEOUT_MS`) an error is returned so qodercli can recover.

Host tool calls thus remain ordinary tool rounds on the host side, while qodercli only sees an MCP tool "executed once".

### 4. Model catalog adaptation

- **Live catalog**: `QoderModelCatalog` sends a `get_models` control request to qodercli, with TTL caching (default 300s), shared concurrency, and a timeout fallback to the static table.
- **Static fallback**: `QODER_MODELS` is a captured built-in model table (including `deepseek-v4-flash` / `deepseek-v4-pro` aliases), used when the CLI is unreachable.
- **Provider grouping**: `listModels` splits by the `source` field — built-in models go to `qoder`, account-custom models (`source === 'user'`) go to `qoder-byok`. No manual configuration; everything is fetched live from qodercli.

### 5. Context window & compaction threshold adaptation

The qodercli live catalog reports both the **ceiling** and the **actual window** for each model:

```
maxInputTokens: 1000000          ← model ceiling (1M)
availableContextWindows: [200000, 400000, 1000000]
defaultContextWindow: 200000     ← the window requests actually use
```

The harness compaction engine derives the auto-compaction threshold from `resolveModel().context.contextWindow` (`thresholdTokens = 0.8 × contextWindow`; compaction-basic default `thresholdRatio: 0.8`), and the UI context ring uses it as the denominator. `contextWindow` must therefore reflect **the window requests actually use**, not the model ceiling:

```ts
contextWindow: live.defaultContextWindow ?? live.maxInputTokens ?? DEFAULT_CONTEXT_WINDOW
```

- Using `defaultContextWindow` (the actual window, e.g. 200K) → threshold = 160K, aligned with the provider's real capacity;
- `maxInputTokens` (the ceiling, e.g. 1M) stays only in `availableContextWindows` for the selector to switch;
- If the ceiling were used, the threshold would be inflated (e.g. 800K) and compaction would never fire before the provider rejects the request.

### 6. Context usage metering adaptation

The qodercli stream `usage` frames (`input_tokens` / `output_tokens`) are zeroed by default (no metering data), so real usage cannot be reported directly. The harness `contextPressure` projection uses the most recent request's `inputTokens` as the numerator (`pressureTokens`) to drive the UI ring and compaction checks.

Adaptation: **estimate each request's input on the plugin side with the same measure the harness front-end token meter uses.**

`adapter.stream()` calls `session.recordRequestInput(system, messages)` on every request, rendering the full conversation (system prompt + all messages) via `renderInitialFeed(system, messages)` and estimating tokens as `rendered.length / 4` — the same `CHARS_PER_TOKEN = 4` convention as harness `estimate.ts`. `usage()` prefers this estimate:

```ts
if (this.estimatedInputTokens !== undefined && this.estimatedInputTokens > 0) {
  return { inputTokens: this.estimatedInputTokens, ... }
}
```

The UI context ring, auto-compaction threshold, and the plugin-reported values thus **share one estimation convention**: occupancy display and compaction behavior agree, with no "UI shows 2% while actually near the limit" split.

### 7. Error classification adaptation

qodercli reports context overflow, quota exhaustion, and other rejections uniformly as a generic per-turn error (`error_during_execution`). The harness overflow recovery only triggers on the `CONTEXT_WINDOW_EXCEEDED` code (prune + compact + retry). The plugin therefore maps qodercli error text to harness-routable codes using dsh-llm's shared classifier:

```ts
function classifyTurnError(detail: string): string {
  if (isContextWindowExceededError(detail)) return CONTEXT_WINDOW_EXCEEDED_CODE
  if (isQuotaExceededError(detail)) return QUOTA_EXCEEDED_CODE
  return 'BACKEND_TURN_ERROR'
}
```

Provider context overflow thus triggers harness auto-recovery and quota exhaustion surfaces correctly, instead of dying as an ordinary backend error.

### 8. Compaction responsibility split (dsh vs qoder)

- **Compaction is executed by dsh** (harness compaction-basic): it decides the compaction scope and retention ratio (default `retainRatio: 0.16` keeps the most recent 16%), calls the LLM to produce a checkpoint, and rewrites the session surface.
- **The qoder plugin only acts as the LLM backend**: it feeds dsh's messages to qodercli and returns the replies. Compaction summary requests go through the side-channel `coldStream()` and reuse the main session's model (see §1), so the summary target dsh records matches what actually runs.
- **No-conflict guarantee**: after dsh compaction rewrites the surface, the plugin's `planContinuation` detects the message structure change (`rebuild: true`) and rebuilds the warm session. qodercli's internal cache is invalidated along with the dsh compaction — **there is never "both sides compacting"**.
- Summaries default to the main session route; to bypass a specific provider's quota, point compaction-basic's `summarizationProvider` / `summarizationModel` at another model with quota in `cordis.patch.yml`.

## Installation

Prerequisites: a local `qodercli` binary with an active login (`qodercli --version` runs). The plugin fully reuses the qodercli login state — no API key or settings section needed.

### From the release tarball

1. Get the package: this repository's Releases may be empty, so build it locally with `pnpm install && pnpm pack` in the repo root (`pnpm pack` builds `lib/` first);
2. Add it to the target profile:

   ```sh
   dsh plugin --profile <profile> add mreate-dsh-llm-qoder-<version>.tgz
   ```

3. **First install requires approving a build script**: `@qoder-ai/qoder-agent-sdk` ships a postinstall (downloads the worker runtime), which pnpm 11+ blocks by default with `ERR_PNPM_IGNORED_BUILDS`. dsh writes the pending key into the profile's `pnpm-workspace.yaml` placeholder (`'@qoder-ai/qoder-agent-sdk': set this to true or false` under `allowBuilds`); set it to `true` and rerun the add command to finish — this is dsh's standard fail-loud flow for any dependency with postinstall scripts;
4. Verify: `dsh --profile <profile> --dump-config | grep llm-qoder` shows the plugin entry; after restarting the service, the model selector offers `qoder` / `qoder-byok`.

### Manual mount (optional)

Without the plugin command, declare it directly in cordis.yml or a patch layer (the plugin's package.json also declares `dsh.bundle`, so plugin add joins it to the profile's bundles automatically):

```yaml
- id: llm-qoder
  name: '@mreate/dsh-llm-qoder'
```

### Usage & troubleshooting

- Pick a model under `qoder` (account built-ins) or `qoder-byok` (account custom models) in the dialog model selector or the Models settings page; context window and reasoning effort are switchable in the model panel.
- **Custom models or the context-window switch gone**: usually the live catalog fetch failed during a qodercli auto-upgrade window or because the account quota ran out (the backend marks models `isEnabled: false`), so the plugin fell back to the static catalog. Failed fetches are not cached; once the CLI recovers, the live catalog returns automatically — no service restart needed.

## Configuration

| Field | Type | Default | Description |
| --- | --- | --- | --- |
| `maxSessions` | number | `8` | Max warm inner qodercli sessions kept (beyond this, LRU eviction by insertion order) |
| `modelCacheTtlSeconds` | number | `300` | Freshness TTL for the CLI model catalog cache |

## Context Management & Compaction

Warm inner sessions accumulate the whole host history: the first turn feeds the full history (`renderInitialFeed`), and each later turn feeds only the increment (new user messages, in-place refreshes). The inner context thus grows with the conversation, up to the model's hard ceiling (e.g. 1048576 tokens).

- **Overflow auto-recovery**: when the inner model reports context overflow, the plugin reports `CONTEXT_WINDOW_EXCEEDED`. The harness overflow recovery (`dsh-compaction-basic`'s `agent/request-error` handler) compacts the host history and retries; once the history shrinks, the next request detects the rollback and rebuilds the inner session, cold-feeding the compacted history.
- **Prerequisite**: the deployment must load `dsh-compaction-basic` (`auto` defaults to `true`) and `dsh-token-meter`. Without a compaction plugin, the overflowing turn still fails — only a new session or manual compaction helps.
- **Consider lowering the pressure threshold**: the default `thresholdRatio` of 0.8 × model contextWindow (1048576 → ~838k) may fire late, especially since host-side token estimation can drift from the inner real usage. Lowering it to 0.6 makes pressure compaction fire well before overflow:

  ```yaml
  - id: compaction-basic
    config:
      auto: true
      thresholdRatio: 0.6
      retainRatio: 0.16
  ```

  You can also configure the `qoder` route separately via `modelPolicies`.
- **Manual compaction**: with `dsh-command-compact` loaded, type `/compact` in the conversation to compact immediately.
- **Already-overflowed sessions**: when the history already exceeds the model ceiling, "continue" only retries with longer history and fails again; run `/compact` first (or wait for pressure compaction after lowering the threshold), otherwise start a new session.

## Source Layout

| File | Responsibility |
| --- | --- |
| `src/index.ts` | Plugin entry: `ctx.llm.registerAdapter(['qoder', 'qoder-byok'], adapter)` |
| `src/adapter.ts` | `QoderAdapter`: model listing/resolution/streaming, warm session management, continuation planning, side-channel model pass-through, request input estimation |
| `src/session.ts` | `QoderSession`: inner `query()` subprocess, MCP tool bridge, SDK stream events → harness `StreamChunk`, usage reporting (input estimation + error classification) |
| `src/models.ts` | Live model catalog fetch (TTL cache, shared concurrency, timeout, static fallback) |
| `src/catalog.ts` | Static model table and `deepseek-v4-*` aliases |
| `src/render.ts` | Host messages → inner plain-text feed; identity override |
| `src/jsonschema.ts` | dsh `ToolSchema.parameters` → zod shape (for MCP tool registration) |

## Development & Build

This repo **commits its build artifacts** `lib/` (`lib/index.js` + `lib/types/*.d.ts`); the sources are only `src/` and `tests/`.

Why the artifacts are committed: while preparing a git dependency, pnpm gates on the presence of an **install-time** script such as `prepare` and then demands an `allowBuilds` entry from the consumer — and that entry must be keyed by `name@<resolved tarball URL>`, which carries the commit hash and therefore changes on every push. With the artifacts committed and no install-time script, a `github:` install needs no extra allowlisting at all (only the by-name build approval for `@qoder-ai/qoder-agent-sdk` remains).

So this package has **no** `prepare`; the build hangs off `prepack`, which runs only for pack / publish:

```sh
pnpm install     # dependencies only; does not build
pnpm run build   # manual build: tsc emits lib/types/*.d.ts, tsdown bundles lib/index.js
pnpm test        # vitest unit tests
pnpm pack        # prepack builds first, then produces mreate-dsh-llm-qoder-<version>.tgz
pnpm publish     # prepack builds first
```

> After changing `src/`, run `pnpm run build` and commit `lib/` too — otherwise a git install keeps serving the previous artifacts.

The build config is in place (`tsconfig.json` + `tsdown.config.ts`); peer dependencies `@deepseek-ai/dsh-llm`, `@deepseek-ai/cordis`, and `@deepseek-ai/schemastery` stay external — the harness runtime supplies all three as shared packages, so they must not be installed into a profile.

> **Version note**: this plugin targets DeepSeek Harness **0.1.7-rc.2** (the desktop profile's current runtime). The peer range is `@deepseek-ai/dsh-llm@^0.1.7-rc.2`, compiled against the runtime sharedPackages versions `@deepseek-ai/cordis@4.0.4` + `@deepseek-ai/schemastery@3.18.4`. The 0.1.7 settings seam projects a plugin's `Config` form by profile entry id, so the plugin no longer registers a settings namespace and no longer depends on `@deepseek-ai/dsh-settings`.

## License

[MIT](LICENSE) © 2026 dsh-llm-qodersdk contributors
