/**
 * Feed rendering: block, message, and feed composition pure functions.
 */
import { describe, expect, it } from 'vitest'
import { MessageId, ToolCallId } from '@deepseek-ai/dsh-llm/brand'
import type { ContentBlock, Message } from '@deepseek-ai/dsh-llm'
import {
  renderBlocks, renderIdentityAppend, renderInitialFeed, renderMessage, renderRefreshed,
  renderSystemUpdate, renderUserTurn,
} from '../src/render.ts'

function text(content: string): ContentBlock {
  return { type: 'text', text: content }
}

function userMessage(content: ContentBlock[], extra: Partial<Message> = {}): Message {
  return {
    id: MessageId('m1'),
    role: 'user',
    content,
    source: { kind: 'user' },
    ...extra,
  }
}

describe('renderBlocks', () => {
  it('joins text blocks with newlines', () => {
    expect(renderBlocks([text('a'), text('b')])).toBe('a\nb')
  })

  it('skips reasoning blocks', () => {
    expect(renderBlocks([text('a'), { type: 'reasoning', text: 'think' }])).toBe('a')
  })

  it('renders image blocks as placeholders', () => {
    expect(renderBlocks([{ type: 'image', attachment: { attachmentId: 'x', mimeType: 'image/png', byteLength: 1, width: 1, height: 1 } }])).toBe('[图片附件]')
  })

  it('renders tool calls as placeholders', () => {
    expect(renderBlocks([{ type: 'tool-call', id: ToolCallId('c1'), name: 'read', arguments: '{"path":"a"}' }]))
      .toBe('[调用了工具 read({"path":"a"})]')
  })

  it('renders tool results as tool-role messages', () => {
    expect(renderMessage({
      id: MessageId('m2'),
      role: 'tool',
      source: { kind: 'tool', callId: ToolCallId('c1') },
      toolCallId: ToolCallId('c1'),
      content: [text('ok')],
    })).toBe('[工具结果] ok')
  })

  it('serializes unknown blocks as JSON', () => {
    expect(renderBlocks([{ type: 'bogus' } as unknown as ContentBlock])).toBe('{"type":"bogus"}')
  })
})

describe('renderMessage', () => {
  it('tags system, user, and assistant roles', () => {
    const system = userMessage([text('s')], { role: 'system', source: { kind: 'system-prompt' } })
    const assistant = userMessage([text('a')], {
      role: 'assistant',
      source: { kind: 'model', provider: 'qoder', model: 'dmodel' },
    })
    expect(renderMessage(system)).toBe('[系统提示] s')
    expect(renderMessage(userMessage([text('u')]))).toBe('[用户] u')
    expect(renderMessage(assistant)).toBe('[助手] a')
  })
})

describe('renderInitialFeed', () => {
  it('includes the backend role even without system or history', () => {
    const feed = renderInitialFeed(undefined, [])
    expect(feed).toContain('你在为一个编码 agent（宿主）充当 LLM API 后端')
    expect(feed).toContain('输出下一条助手回复')
  })

  it('embeds the host system prompt when present', () => {
    const feed = renderInitialFeed('你是 Qoder', [])
    expect(feed).toContain('---- 宿主系统提示（作为你的行为准则） ----\n你是 Qoder')
  })

  it('renders prior history as compact context', () => {
    const feed = renderInitialFeed(undefined, [userMessage([text('hi')])])
    expect(feed).toContain('---- 宿主对话记录 ----\n[用户] hi')
  })
})

describe('turn rendering', () => {
  it('renders a brand-new user turn', () => {
    expect(renderUserTurn([text('hi')])).toBe('[用户] hi')
  })

  it('marks an in-place refresh', () => {
    expect(renderRefreshed(userMessage([text('x')]))).toBe('[用户] x\n（宿主原位刷新了这条消息）')
  })

  it('marks a mid-session system update', () => {
    expect(renderSystemUpdate('new rules')).toBe('[系统提示(更新)] new rules')
  })
})

describe('renderIdentityAppend', () => {
  it('forbids Qoder self-identification without a host system', () => {
    const append = renderIdentityAppend(undefined)
    expect(append).toContain('不要自称 Qoder')
    expect(append).not.toContain('---- 宿主系统提示（作为你的行为准则与对外身份） ----')
  })

  it('embeds the host system when present', () => {
    const append = renderIdentityAppend('你是宿主')
    expect(append).toContain('---- 宿主系统提示（作为你的行为准则与对外身份） ----\n你是宿主')
  })
})
