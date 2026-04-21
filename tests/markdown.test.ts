/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { renderAssistantContent, renderAssistantMarkdown } from '@/lib/agent/markdown'

describe('markdown', () => {
  it('渲染并消毒 HTML', () => {
    const html = renderAssistantMarkdown('# 标题\n\n<script>alert(1)</script>')
    expect(html).toContain('标题')
    expect(html).not.toContain('script')
  })

  it('redacted_thinking 段落入折叠块且默认可收起', () => {
    const html = renderAssistantContent(
      '<think>内部推理</think>\n\n你好',
    )
    expect(html).toContain('details')
    expect(html).toContain('思考过程')
    expect(html).toContain('内部推理')
    expect(html).toContain('你好')
    expect(html).not.toContain('<think>')
  })

  it('think 标签同样折叠', () => {
    const html = renderAssistantContent('<think>推理</think>\n\n正文')
    expect(html).toContain('details')
    expect(html).toContain('推理')
    expect(html).toContain('正文')
  })

  it('思考块内尖括号被转义', () => {
    const html = renderAssistantContent('<think><b>x</b></think>')
    expect(html).toContain('&lt;b&gt;')
    expect(html).not.toContain('<b>x</b>')
  })
})
