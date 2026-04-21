import { renderAssistantContent } from '@/lib/agent/markdown'

export type ChatMsg = Record<string, unknown>

function safeJsonParse(value: string): unknown {
  try {
    return JSON.parse(value)
  } catch {
    return { raw: value }
  }
}

/** 单条消息 → DOM（与 React ChatMessage 行为对齐） */
export function createChatMessageEl(
  msg: ChatMsg,
  messageIndex: number,
  opts: {
    onRewindToUserMessage?: (index: number) => void
  } = {},
): HTMLElement | null {
  const role = msg.role as string
  const content = msg.content

  if (role === 'user') {
    if (Array.isArray(content)) return null
    const wrap = document.createElement('div')
    wrap.className = 'chat-msg chat-msg-user'

    const inner = document.createElement('div')
    inner.className = 'chat-msg-user-inner'

    if (typeof opts.onRewindToUserMessage === 'function') {
      const rewind = document.createElement('button')
      rewind.type = 'button'
      rewind.className = 'chat-user-rewind-btn'
      rewind.title = '回退到此消息'
      rewind.setAttribute('aria-label', '回退到此消息')
      rewind.textContent = '↩'
      rewind.addEventListener('click', (e) => {
        e.stopPropagation()
        if (window.confirm('回退到这条消息后，之后的消息会被删除。确定？')) {
          opts.onRewindToUserMessage!(messageIndex)
        }
      })
      inner.appendChild(rewind)
    }

    const bubble = document.createElement('div')
    bubble.className = 'chat-bubble chat-bubble-user'
    bubble.textContent = typeof content === 'string' ? content : String(content ?? '')
    inner.appendChild(bubble)
    wrap.appendChild(inner)
    return wrap
  }

  if (role === 'tool') {
    return createToolResultBlock(msg)
  }

  if (role === 'error') {
    return createErrorResultBlock(msg)
  }

  if (role === 'assistant') {
    const frag = document.createDocumentFragment()
    const rendered: HTMLElement[] = []

    if (Array.isArray(content)) {
      for (const block of content as Array<Record<string, unknown>>) {
        if (!block) continue
        if (block.type === 'text' && block.text) {
          rendered.push(createAssistantTextBubble(String(block.text)))
        } else if (block.type === 'tool_use') {
          rendered.push(createToolCallBlock(String(block.name || 'tool'), block.input))
        }
      }
    }

    const toolCalls = msg.tool_calls as Array<Record<string, unknown>> | undefined
    if (toolCalls && toolCalls.length > 0) {
      if (content && typeof content === 'string') {
        rendered.push(createAssistantTextBubble(content))
      }
      for (const tc of toolCalls) {
        const toolName = (tc.function as { name?: string } | undefined)?.name || (tc.name as string) || 'tool'
        let input: unknown =
          (tc.function as { arguments?: unknown } | undefined)?.arguments ??
          tc.arguments ??
          tc.args ??
          {}
        if (typeof input === 'string') {
          try {
            input = JSON.parse(input)
          } catch {
            input = { raw: input }
          }
        }
        rendered.push(createToolCallBlock(toolName, input))
      }
    }

    if (rendered.length > 0) {
      const wrap = document.createElement('div')
      wrap.className = 'chat-msg-group'
      for (const el of rendered) wrap.appendChild(el)
      return wrap
    }

    if (content && typeof content === 'string') {
      return createAssistantTextBubble(content)
    }

    return null
  }

  return null
}

function createAssistantTextBubble(text: string): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'chat-msg chat-msg-assistant'
  const bubble = document.createElement('div')
  bubble.className = 'chat-bubble chat-bubble-assistant'
  bubble.innerHTML = renderAssistantContent(text)
  wrap.appendChild(bubble)
  return wrap
}

function createToolCallBlock(name: string, input: unknown): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tool-result-msg'
  let expanded = false

  let detail = ''
  if (!input || typeof input !== 'object') {
    detail = String(input || '')
  } else {
    const o = input as Record<string, unknown>
    if (o.tabId) detail = `Tab ${o.tabId}`
    else if (o.tabIds) detail = `${(o.tabIds as unknown[]).length} tabs`
    else if (o.url) detail = String(o.url)
    else if (o.query) detail = String(o.query)
    else detail = JSON.stringify(input)
  }

  const header = document.createElement('div')
  header.className = 'tool-result-header'
  const arrow = document.createElement('span')
  arrow.className = 'tool-result-arrow'
  arrow.textContent = '▶'
  const label = document.createElement('span')
  label.className = 'tool-result-label'
  label.textContent = `🔧 ${name || 'tool'}(${detail})`
  header.append(arrow, label)

  const pre = document.createElement('pre')
  pre.className = 'tool-result-content'
  pre.style.display = 'none'
  pre.textContent = typeof input === 'object' ? JSON.stringify(input, null, 2) : String(input)

  wrap.append(header, pre)
  wrap.addEventListener('click', () => {
    expanded = !expanded
    arrow.textContent = expanded ? '▼' : '▶'
    pre.style.display = expanded ? 'block' : 'none'
  })
  return wrap
}

function createToolResultBlock(msg: ChatMsg): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tool-result-msg'
  let expanded = false

  const { content, displayImageUrl, tool_name: toolName } = msg as {
    content?: string
    displayImageUrl?: string
    tool_name?: string
  }

  let label = 'tool result'
  let isError = false

  if (typeof content === 'string') {
    try {
      const parsed = JSON.parse(content) as Record<string, unknown>
      if (parsed.error) {
        isError = true
        label = String(parsed.error)
      } else if (parsed.title) label = String(parsed.title)
      else if (parsed.success) label = (parsed.url as string) || (parsed.name as string) || 'success'
      else if (parsed.result)
        label = typeof parsed.result === 'string' ? parsed.result.substring(0, 60) : 'result'
    } catch {
      /* ignore */
    }
  } else if (content && typeof content === 'object') {
    const c = content as Record<string, unknown>
    if (c.error) {
      isError = true
      label = String(c.error)
    } else if (c.title) label = String(c.title)
    else if (c.success) label = (c.url as string) || (c.name as string) || 'success'
  }

  const displayContent = typeof content === 'string' ? content : JSON.stringify(content, null, 2)
  if (toolName && label === 'success') label = toolName

  if (isError) wrap.classList.add('tool-result-error')

  const header = document.createElement('div')
  header.className = 'tool-result-header'
  const arrow = document.createElement('span')
  arrow.className = 'tool-result-arrow'
  arrow.textContent = '▶'
  const lbl = document.createElement('span')
  lbl.className = 'tool-result-label'
  lbl.textContent = `${isError ? '❌' : '✅'} ${label}`
  header.append(arrow, lbl)
  wrap.appendChild(header)

  if (displayImageUrl) {
    const imgWrap = document.createElement('div')
    imgWrap.className = 'tool-result-content'
    imgWrap.style.paddingTop = '8px'
    const img = document.createElement('img')
    img.src = displayImageUrl
    img.alt = toolName || 'tool screenshot'
    Object.assign(img.style, {
      display: 'block',
      maxWidth: '100%',
      width: '100%',
      maxHeight: '180px',
      objectFit: 'contain',
      borderRadius: '8px',
      background: '#f5f5f5',
    } as CSSStyleDeclaration)
    imgWrap.appendChild(img)
    wrap.appendChild(imgWrap)
  }

  const pre = document.createElement('pre')
  pre.className = 'tool-result-content'
  pre.style.display = 'none'
  pre.textContent = displayContent
  wrap.appendChild(pre)

  wrap.addEventListener('click', () => {
    expanded = !expanded
    arrow.textContent = expanded ? '▼' : '▶'
    pre.style.display = expanded ? 'block' : 'none'
    const imgEl = wrap.querySelector('img')
    if (imgEl) {
      ;(imgEl as HTMLImageElement).style.maxHeight = expanded ? '420px' : '180px'
    }
  })

  return wrap
}

function createErrorResultBlock(msg: ChatMsg): HTMLElement {
  const wrap = document.createElement('div')
  wrap.className = 'tool-result-msg tool-result-error'
  let expanded = false
  const content = msg.content
  const payload =
    typeof content === 'string' ? (safeJsonParse(content) as Record<string, unknown>) : (content as Record<string, unknown>) || {}
  const code = (payload.code as string) || 'LLM_ERROR'
  const message = (payload.message as string) || 'LLM 请求失败'
  const attempts = Number(payload.attempts) || 1
  const maxAttempts = Number(payload.maxAttempts) || attempts
  const summary = `${code}: ${message}`

  const header = document.createElement('div')
  header.className = 'tool-result-header'
  const arrow = document.createElement('span')
  arrow.className = 'tool-result-arrow'
  arrow.textContent = '▶'
  const lbl = document.createElement('span')
  lbl.className = 'tool-result-label'
  lbl.textContent = `❌ ${summary}（重试 ${attempts}/${maxAttempts}）`
  header.append(arrow, lbl)

  const pre = document.createElement('pre')
  pre.className = 'tool-result-content'
  pre.style.display = 'none'
  pre.textContent = JSON.stringify({ ...payload, attempts, maxAttempts }, null, 2)

  wrap.append(header, pre)
  wrap.addEventListener('click', () => {
    expanded = !expanded
    arrow.textContent = expanded ? '▼' : '▶'
    pre.style.display = expanded ? 'block' : 'none'
  })
  return wrap
}
