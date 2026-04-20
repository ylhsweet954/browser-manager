/**
 * @vitest-environment jsdom
 */
import { describe, expect, it } from 'vitest'
import { renderAssistantMarkdown } from '@/lib/agent/markdown'

describe('markdown', () => {
  it('渲染并消毒 HTML', () => {
    const html = renderAssistantMarkdown('# 标题\n\n<script>alert(1)</script>')
    expect(html).toContain('标题')
    expect(html).not.toContain('script')
  })
})
