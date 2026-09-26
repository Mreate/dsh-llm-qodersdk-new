/**
 * Render harness messages into the plain-text turns fed to the inner Qoder
 * session. Tool calls and results need no protocol here — they travel through
 * the in-process MCP server — so this layer only handles conversational
 * context: the host system prompt, user turns, and (for full rebuilds) prior
 * history as compact text.
 * @module dsh-llm-qoder/render
 */
/**
 * Render one content-block list as plain text; non-text blocks get
 * placeholders. Tool results are no longer a block type at this seam — they
 * arrive as `tool`-role messages and are rendered by {@link renderMessage} —
 * so `tool-call` is the only tool vocabulary that appears here.
 */
export function renderBlocks(blocks) {
    const parts = [];
    for (const block of blocks) {
        switch (block.type) {
            case 'text':
                parts.push(block.text);
                break;
            case 'reasoning': break;
            case 'image':
                parts.push('[图片附件]');
                break;
            case 'file':
                parts.push('[文件附件]');
                break;
            case 'tool-call':
                parts.push(`[调用了工具 ${block.name}(${block.arguments})]`);
                break;
            default: parts.push(JSON.stringify(block));
        }
    }
    return parts.join('\n');
}
/** Render one message with its role tag. */
export function renderMessage(message) {
    const text = renderBlocks(message.content);
    switch (message.role) {
        case 'system': return `[系统提示] ${text}`;
        case 'developer': return `[开发者] ${text}`;
        case 'user': return `[用户] ${text}`;
        case 'assistant': return `[助手] ${text}`;
        case 'tool': return `[工具结果] ${text}`;
    }
}
/** Preamble establishing the inner model's role as this agent's LLM backend. */
const BACKEND_ROLE = [
    '你在为一个编码 agent（宿主）充当 LLM API 后端：宿主把它的对话喂给你，你只输出"下一条助手回复"本身。',
    '宿主的工具已经通过 MCP 挂进来，需要用工具时直接调用，不要描述你会在别的环境里怎么调。',
    '不要复述对话，不要解释你的角色。',
].join('\n');
/**
 * Compose the first feed for a fresh session: backend role, the host system
 * prompt, and the existing conversation as compact context.
 */
export function renderInitialFeed(system, messages) {
    const parts = [BACKEND_ROLE];
    if (system !== undefined && system.length > 0) {
        parts.push(`---- 宿主系统提示（作为你的行为准则） ----\n${system}`);
    }
    const history = messages.map(renderMessage).filter(part => part.length > 0);
    if (history.length > 0)
        parts.push(`---- 宿主对话记录 ----\n${history.join('\n\n')}`);
    parts.push('---- 以上是背景。输出下一条助手回复。 ----');
    return parts.join('\n\n');
}
/** Render a brand-new host user turn. */
export function renderUserTurn(blocks) {
    return `[用户] ${renderBlocks(blocks)}`;
}
/** Render an in-place-updated message (runtime-context snapshots and the like). */
export function renderRefreshed(message) {
    return `${renderMessage(message)}\n（宿主原位刷新了这条消息）`;
}
/** Render a host system-prompt update mid-session. */
export function renderSystemUpdate(system) {
    return `[系统提示(更新)] ${system}`;
}
/**
 * Identity override appended to the qodercli preset system prompt: the inner
 * model answers as the host's agent, never as Qoder itself.
 */
export function renderIdentityAppend(hostSystem) {
    const parts = [
        '你当前作为一个宿主编码 agent 的内置 LLM 后端运行：对外身份以宿主的设定为准。',
        '当被问及“你是谁”这类身份问题时，按宿主系统提示中的身份回答；不要自称 Qoder，不要提及 qodercli、SDK 或你作为内部后端的事实。',
    ];
    if (hostSystem !== undefined && hostSystem.length > 0) {
        parts.push(`---- 宿主系统提示（作为你的行为准则与对外身份） ----\n${hostSystem}`);
    }
    return parts.join('\n\n');
}
//# sourceMappingURL=render.js.map