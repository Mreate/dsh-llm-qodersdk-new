/**
 * One long-lived inner Qoder CLI session per host session id: a channel-fed
 * `query()` subprocess whose model continuation streams out as harness
 * `StreamChunk`s. Host tool calls travel through an in-process MCP server:
 * the handler parks on a promise, the adapter finishes the turn with
 * `tool-calls`, and the next host request (carrying tool results) resolves
 * the parked promise so the inner model continues with the result in place.
 * @module dsh-llm-qoder/session
 */
import type { ContentBlock, GenerateOptions, RequestMessage, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm';
/** MCP server name this adapter exposes host tools under. */
export declare const MCP_SERVER_NAME = "dsh-host";
/**
 * The host tool runtime dispatches by the bare host name; the inner model
 * only ever sees the namespaced MCP form, so strip the prefix on the way out.
 */
export declare function hostToolName(name: string): string;
/** Deny native tools, allow this adapter's MCP tools. */
export declare function gateTools(toolName: string, _input: unknown, options: {
    toolUseID?: string;
}): Promise<unknown>;
/**
 * One warm inner session. All mutation happens on the consumer fiber except
 * the documented turn lifecycle driven by {@link stream}.
 */
export declare class QoderSession {
    readonly sessionId: string;
    private readonly channel;
    /**
     * Lazy: the MCP SDK refuses tool registration after the transport connects,
     * so the inner process only spawns once {@link ensureTools} has registered
     * the host tools (the adapter does that immediately before each stream).
     */
    private q;
    /**
     * Tool-call pairing state. qodercli asks `canUseTool` (with the qodercli
     * tool-use id) once per call in execution order, then sends the MCP message;
     * the host sees tool calls as content blocks and delivers all results up
     * front on the next request. Tool-use ids therefore arrive in the handler in
     * canUseTool order, and host callIds map back to them via the content-block
     * ids — so handlers park under the exact tool-use id, never a shifted FIFO
     * slot. Results buffer by tool-use id until their handler fires.
     */
    private readonly parked;
    private readonly pendingResults;
    /** qodercli tool-use ids in canUseTool (execution) order, claimed by MCP handlers. */
    private readonly toolUseQueue;
    /** Host callId (qoder-N) → qodercli tool-use id, from the content-block ids. */
    private readonly hostCallByToolUse;
    private readonly mcp;
    private readonly registered;
    private queue;
    private model;
    private reasoningEffort;
    private contextWindow;
    private callCounter;
    private abortPending;
    private disposed;
    /** Previous request's messages for delta feeding. */
    fedMessages: readonly RequestMessage[] | undefined;
    fedSystem: string | undefined;
    /** This turn's fed characters, reset per turn for per-call token accounting. */
    turnInputChars: number;
    /** Host system prompt captured before spawn for the boot-time systemPrompt. */
    private hostSystem;
    /** Host session workspace; qodercli runs there so its preset reports the session cwd. */
    private sessionCwd;
    private blockIndex;
    private textBlock;
    private reasoningBlock;
    private openTool;
    private toolCalls;
    private outputChars;
    private reasoningChars;
    /** Last real usage reported by the inner model for the active turn. */
    private lastUsage;
    /**
     * Session-level input token estimate for the CURRENT request, priced the
     * same way the harness token meter prices the surface (4 chars per token
     * on the rendered conversation the inner session actually receives). The
     * qoder CLI zeroes its per-stream usage frames, so without this the harness
     * context meter would read ~0% and auto-compaction would never trigger.
     */
    private estimatedInputTokens;
    constructor(sessionId: string, initialModel: string);
    /** Spawn the inner process (first stream only) and attach the consumer. */
    private ensureStarted;
    /** Point the session at a model and its per-request policy. */
    setModel(model: string, policy?: {
        reasoningEffort?: string;
        contextWindow?: number;
    }): void;
    /** Record the host system prompt; effective only before the process spawns. */
    setSystem(system: string | undefined): void;
    /**
     * Record the host session workspace; effective only before the process
     * spawns. qodercli inherits the host process cwd otherwise, which would
     * make its preset report the server's launch directory instead of the
     * session's workspace.
     */
    setCwd(cwd: string | undefined): void;
    /**
     * Permission gate for the inner process. Native tools are denied; MCP host
     * tools are allowed, and each allowed call's qodercli tool-use id is queued
     * so the matching MCP handler can park under the exact id (qodercli asks
     * once per call, in execution order, before sending the MCP message).
     */
    private canUseTool;
    /** Register any host tools whose schema this session's MCP server lacks. */
    ensureTools(tools: readonly ToolSchema[]): void;
    /** Deliver host tool results to parked/buffered handlers, keyed by callId. */
    deliverToolResults(tail: readonly RequestMessage[]): void;
    /** Run one inner turn: feed (if any) then pump consumer chunks until finish. */
    stream(options: GenerateOptions, feed: string | null): AsyncGenerator<StreamChunk>;
    /** Tear the inner process down; parked calls die with it. */
    close(): void;
    private resetTurnState;
    private emit;
    private usage;
    /**
     * Record the input-token estimate for the CURRENT request, priced the same
     * way the harness token meter prices the surface: 4 chars per token over
     * the rendered conversation (system + messages) the inner session receives.
     * @param system - the host system prompt included in this request.
     * @param messages - the full host message list included in this request.
     */
    recordRequestInput(system: string | undefined, messages: readonly RequestMessage[]): void;
    private endTurn;
    private consume;
    private handle;
}
/** Render tool-result content blocks into the single text the inner model reads. */
export declare function renderResultText(blocks: readonly ContentBlock[]): string;
/** Safely stringify the SDK error payload for turn diagnostics. */
export declare function safeErrors(errors: unknown): string;
/**
 * Classify an inner result-frame failure into a harness-routable code. The
 * qoder backend reports context-window and quota rejections as generic
 * per-turn errors, so their message text must be recognized through the shared
 * dsh-llm classifiers; only then does the harness overflow recovery (or quota
 * surfacing) fire instead of a dead-end BACKEND_TURN_ERROR.
 */
export declare function classifyTurnError(detail: string): string;
/**
 * Warm-session registry with insertion-order LRU eviction, plus the cold
 * one-shot path for side-channel requests (titles, compaction).
 */
export declare class QoderSessionManager {
    readonly maxSessions: number;
    private readonly sessions;
    constructor(maxSessions?: number);
    /** Existing or fresh warm session for one host session id. */
    forSession(sessionId: string, model: string): QoderSession;
    /** Drop one session (history diverged); the next request rebuilds it cold. */
    dispose(sessionId: string): void;
    closeAll(): void;
    /** One-shot turn with no warm state: side channels and cold rebuilds. */
    coldStream(options: GenerateOptions, prompt: string, model?: string): AsyncGenerator<StreamChunk>;
}
//# sourceMappingURL=session.d.ts.map