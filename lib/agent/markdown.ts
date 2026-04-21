import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: true,
})

const THINK_BLOCK_RE =
  /<(?:redacted_thinking|think)>([\s\S]*?)<\/(?:redacted_thinking|think)>/gi

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

const SANITIZE_OPTS = {
  ADD_ATTR: ['class', 'target', 'rel', 'open'],
  ADD_TAGS: ['details', 'summary', 'div'],
} as const

/** 将助手 Markdown 转为可安全插入的 HTML */
export function renderAssistantMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw, SANITIZE_OPTS)
}

/**
 * 渲染助手气泡：正文走 Markdown；&lt;redacted_thinking&gt;（导出）与 &lt;think&gt; 段落包在默认可收起的折叠块中。
 */
export function renderAssistantContent(text: string): string {
  THINK_BLOCK_RE.lastIndex = 0
  if (!text) return renderAssistantMarkdown('')
  if (!THINK_BLOCK_RE.test(text)) {
    return renderAssistantMarkdown(text)
  }
  THINK_BLOCK_RE.lastIndex = 0

  const chunks: string[] = []
  let last = 0
  let m: RegExpExecArray | null
  while ((m = THINK_BLOCK_RE.exec(text)) !== null) {
    if (m.index > last) {
      chunks.push(renderAssistantMarkdown(text.slice(last, m.index)))
    }
    const body = escapeHtml(m[1].trim())
    chunks.push(
      `<details class="chat-think"><summary class="chat-think-summary">思考过程</summary><div class="chat-think-body">${body}</div></details>`,
    )
    last = THINK_BLOCK_RE.lastIndex
  }
  if (last < text.length) {
    chunks.push(renderAssistantMarkdown(text.slice(last)))
  }
  return DOMPurify.sanitize(chunks.join(''), SANITIZE_OPTS)
}
