/**
 * `QoderAdapter`: route the harness LLM seam onto a local Qoder CLI account
 * through the qoder-agent-sdk. One warm inner session per host session id
 * carries the conversation (model turns and tool rounds live inside it); host
 * tool schemas are exposed to the inner model through an in-process MCP
 * server whose handlers park until the host delivers tool results on the next
 * request. Side-channel requests (titles, compaction) run cold one-shots.
 * @module dsh-llm-qoder/adapter
 */

import { LlmAdapter, ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions, LlmModelInfo, LlmModelReasoningInfo, LlmProviderInfo, LlmResolvedModelInfo, RequestMessage, StreamChunk,
} from '@deepseek-ai/dsh-llm'
import {
  DEFAULT_CONTEXT_WINDOW, DEFAULT_MAX_TOKENS, QODER_MODELS, resolveQoderModelId,
} from './catalog.ts'
import { DEFAULT_MODEL_CACHE_TTL_MS, QoderModelCatalog } from './models.ts'
import { renderInitialFeed, renderRefreshed, renderUserTurn } from './render.ts'
import { QoderSession, QoderSessionManager } from './session.ts'

/** Options for {@link QoderAdapter}. */
export interface QoderAdapterOptions {
  /** Maximum simultaneously warm inner sessions (default 8). */
  maxSessions?: number
  /** How long a fetched CLI model catalog stays fresh (default 5 min). */
  modelCacheTtlMs?: number
}

/** The primary provider route (the qoder account's built-in models). */
export const QODER_PROVIDER = 'qoder'
/** Secondary route advertising only the account's custom models. */
export const QODER_BYOK_PROVIDER = 'qoder-byok'

function modelInfo(provider: string, entry: { id: string, name: string, description?: string }): LlmModelInfo {
  return {
    provider,
    id: entry.id,
    name: entry.name,
    ...entry.description === undefined ? {} : { description: entry.description },
    inputModalities: ['text'],
  }
}

/**
 * Default selectable reasoning efforts for a Qoder model. The CLI catalog
 * reports per-model `efforts`; this is the fallback when a model (or the
 * static catalog) discloses none.
 */
const DEFAULT_REASONING_EFFORTS = ['low', 'medium', 'high', 'max'] as const

/** Human display name for the default effort ids. */
const EFFORT_NAMES: Readonly<Record<string, string>> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
}

/**
 * Build the `reasoning` metadata block for a resolved model, or undefined
 * when the model does not support reasoning.
 * @param efforts - CLI-reported effort ids (absent for reasoning-less models).
 * @param defaultEffort - CLI-reported default effort id.
 * @param isReasoning - whether the model supports reasoning per the CLI.
 * @returns the harness reasoning metadata, or undefined to omit it.
 */
export function reasoningInfo(
  efforts: readonly string[] | undefined,
  defaultEffort: string | undefined,
  isReasoning: boolean | undefined,
): LlmModelReasoningInfo | undefined {
  if (efforts === undefined && isReasoning === false) return undefined
  const ids = efforts !== undefined && efforts.length > 0
    ? efforts
    : DEFAULT_REASONING_EFFORTS
  return {
    efforts: ids.map(id => ({
      id: ReasoningEffortId(id),
      name: EFFORT_NAMES[id] ?? id,
    })),
    ...defaultEffort !== undefined && ids.includes(defaultEffort)
      ? { defaultEffort: ReasoningEffortId(defaultEffort) }
      : {},
  }
}

/**
 * The Qoder-backed adapter. Session continuity, tool parking, and feed
 * planning live here; chunk synthesis lives in the session's consumer.
 */
export class QoderAdapter extends LlmAdapter {
  private readonly sessions: QoderSessionManager
  private readonly catalog: QoderModelCatalog

  constructor(options: QoderAdapterOptions = {}) {
    super()
    this.sessions = new QoderSessionManager(options.maxSessions ?? 8)
    this.catalog = new QoderModelCatalog(options.modelCacheTtlMs ?? DEFAULT_MODEL_CACHE_TTL_MS)
  }

  override providerInfo(provider: string): LlmProviderInfo {
    return {
      id: provider,
      name: provider === QODER_BYOK_PROVIDER ? 'Qoder 自定义' : 'Qoder CLI',
    }
  }

  override async listModels(provider: string): Promise<readonly LlmModelInfo[]> {
    const cliModels = await this.catalog.models()
    if (provider === QODER_BYOK_PROVIDER) {
      // Only the account's custom models, which have their own route.
      return cliModels
        .filter(entry => entry.source === 'user')
        .map(entry => modelInfo(provider, entry))
    }
    // The built-in route lists the qoder account's own models, excluding the
    // custom models that have their own route.
    return cliModels
      .filter(entry => entry.source !== 'user')
      .map(entry => modelInfo(provider, entry))
  }

  override async resolveModel(
    provider: string,
    model: string,
    _signal?: AbortSignal,
  ): Promise<LlmResolvedModelInfo> {
    const live = (await this.catalog.liveModels()).find(entry => entry.value === model)
    if (live !== undefined) {
      const reasoning = reasoningInfo(live.efforts, live.defaultEffort, live.isReasoning)
      return {
        provider,
        id: live.value,
        name: live.displayName.length > 0 ? live.displayName : live.value,
        ...live.description.length > 0 ? { description: live.description } : {},
        inputModalities: ['text' as const],
        context: {
          // The compaction engine and context meter price against the window
          // a request actually uses. qodercli reports maxInputTokens as the
          // model's CEILING (often 1M) while defaultContextWindow is the
          // effective per-session window (e.g. 200K); using the ceiling would
          // push the auto-compaction threshold far past what the provider
          // accepts. Prefer the default window; the seam's context shape
          // carries the window alone.
          contextWindow: live.defaultContextWindow
            ?? live.maxInputTokens
            ?? DEFAULT_CONTEXT_WINDOW,
        },
        defaultMaxTokens: live.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
        ...reasoning === undefined ? {} : { reasoning },
      }
    }
    const configured = QODER_MODELS.find(entry => entry.id === model)
    const reasoning = reasoningInfo(undefined, undefined, true)
    return Promise.resolve({
      ...configured === undefined
        ? { provider, id: model, name: model, inputModalities: ['text' as const] }
        : modelInfo(provider, configured),
      context: { contextWindow: DEFAULT_CONTEXT_WINDOW },
      defaultMaxTokens: DEFAULT_MAX_TOKENS,
      ...reasoning === undefined ? {} : { reasoning },
    })
  }

  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    const model = resolveQoderModelId(options.model)
    if (options.sessionId === undefined || options.purpose !== undefined) {
      const prompt = renderInitialFeed(options.system, options.messages)
        + '\n（这是一次性旁路请求，直接输出下一条助手回复。）'
      // Side channels (titles, compaction summaries) reuse the main session's
      // model so dsh's recorded summarization target matches what qodercli
      // actually runs — a different default route could have different
      // context limits or quota, silently failing the compaction.
      yield* this.sessions.coldStream(options, prompt, model)
      return
    }
    const sessionId = String(options.sessionId)
    // `GenerateOptions` no longer carries a context window: the seam reads the
    // route's capacity from `resolveModel().context` instead, so the only
    // per-request policy left to forward is the reasoning effort.
    const policy = {
      ...options.reasoningEffort === undefined ? {} : { reasoningEffort: options.reasoningEffort },
    }
    let session = this.sessions.forSession(sessionId, model)
    if (session.fedMessages === undefined) {
      yield* this.firstTurn(session, options, model, policy)
      return
    }
    session.deliverToolResults(options.messages.slice(session.fedMessages.length))
    const plan = planContinuation(session.fedMessages, options.messages)
    if (plan.rebuild) {
      this.sessions.dispose(sessionId)
      session = this.sessions.forSession(sessionId, model)
      yield* this.firstTurn(session, options, model, policy)
      return
    }
    session.setModel(model, policy)
    session.ensureTools(options.tools ?? [])
    session.recordRequestInput(options.system, options.messages)
    session.fedMessages = options.messages
    session.fedSystem = options.system
    yield* session.stream(options, plan.feed)
  }

  private async *firstTurn(
    session: QoderSession,
    options: GenerateOptions,
    model: string,
    policy: { reasoningEffort?: string, contextWindow?: number },
  ): AsyncGenerator<StreamChunk> {
    session.setModel(model, policy)
    session.setSystem(options.system)
    // Older dsh-llm releases lack the cwd field on GenerateOptions; read it
    // through the widened view so this adapter compiles against the peer range.
    const cwd = (options as GenerateOptions & { cwd?: string }).cwd
    session.setCwd(cwd)
    session.ensureTools(options.tools ?? [])
    session.recordRequestInput(options.system, options.messages)
    session.fedMessages = options.messages
    session.fedSystem = options.system
    yield* session.stream(options, renderInitialFeed(options.system, options.messages))
  }

/** Tear down every warm inner session (plugin dispose). */
  close(): void {
    this.sessions.closeAll()
  }
}

interface ContinuationPlan {
  /** Text to feed the inner session this turn, or null for a pure continuation. */
  feed: string | null
  /** Whether the warm session must be rebuilt (history diverged past repair). */
  rebuild: boolean
}

/**
 * Decide what to feed on a continuation request. The previous list must be a
 * prefix (same length growth, index 0 untouched, at most two in-place
 * mutations — the host refreshes runtime-context snapshots in place every
 * turn). Tail tool-result messages were already resolved into parked handlers
 * and never feed; fresh user turns and mutated messages do.
 */
export function planContinuation(previous: readonly RequestMessage[], current: readonly RequestMessage[]): ContinuationPlan {
  if (current.length <= previous.length) return { feed: null, rebuild: true }
  const mutated: number[] = []
  for (let i = 0; i < previous.length; i++) {
    if (JSON.stringify(previous[i]) !== JSON.stringify(current[i])) mutated.push(i)
  }
  if (mutated.includes(0) || mutated.length > 2) return { feed: null, rebuild: true }
  const tail = current.slice(previous.length)
  // Tool results are `tool`-role messages at this seam, so every `user`-role
  // message in the tail is a genuine new host turn.
  const freshUser = tail.filter(m => m.role === 'user')
  if (freshUser.length === 0 && mutated.length === 0) return { feed: null, rebuild: false }
  const parts: string[] = []
  for (const index of mutated) {
    const message = current[index]
    if (message !== undefined) parts.push(renderRefreshed(message))
  }
  for (const message of freshUser) parts.push(renderUserTurn(message.content))
  return { feed: parts.join('\n\n'), rebuild: false }
}
