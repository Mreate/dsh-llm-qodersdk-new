/**
 * Render harness messages into the plain-text turns fed to the inner Qoder
 * session. Tool calls and results need no protocol here — they travel through
 * the in-process MCP server — so this layer only handles conversational
 * context: the host system prompt, user turns, and (for full rebuilds) prior
 * history as compact text.
 * @module dsh-llm-qoder/render
 */
import type { ContentBlock, RequestMessage } from '@deepseek-ai/dsh-llm';
/**
 * Render one content-block list as plain text; non-text blocks get
 * placeholders. Tool results are no longer a block type at this seam — they
 * arrive as `tool`-role messages and are rendered by {@link renderMessage} —
 * so `tool-call` is the only tool vocabulary that appears here.
 */
export declare function renderBlocks(blocks: readonly ContentBlock[]): string;
/** Render one message with its role tag. */
export declare function renderMessage(message: RequestMessage): string;
/**
 * Compose the first feed for a fresh session: backend role, the host system
 * prompt, and the existing conversation as compact context.
 */
export declare function renderInitialFeed(system: string | undefined, messages: readonly RequestMessage[]): string;
/** Render a brand-new host user turn. */
export declare function renderUserTurn(blocks: readonly ContentBlock[]): string;
/** Render an in-place-updated message (runtime-context snapshots and the like). */
export declare function renderRefreshed(message: RequestMessage): string;
/** Render a host system-prompt update mid-session. */
export declare function renderSystemUpdate(system: string): string;
/**
 * Identity override appended to the qodercli preset system prompt: the inner
 * model answers as the host's agent, never as Qoder itself.
 */
export declare function renderIdentityAppend(hostSystem: string | undefined): string;
//# sourceMappingURL=render.d.ts.map