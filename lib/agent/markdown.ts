import DOMPurify from 'dompurify'
import { marked } from 'marked'

marked.setOptions({
  gfm: true,
  breaks: true,
})

/** 将助手 Markdown 转为可安全插入的 HTML */
export function renderAssistantMarkdown(text: string): string {
  const raw = marked.parse(text, { async: false }) as string
  return DOMPurify.sanitize(raw, {
    ADD_ATTR: ['class', 'target', 'rel'],
  })
}
