/* global chrome */
import { BUILTIN_TOOL_COUNT, buildMcpToolCallName } from '@/lib/api/llm'
import { connectMcpServer } from '@/lib/api/mcp'
import { openModal } from '@/entrypoints/sidepanel/ui/modal'
import { toast } from '@/entrypoints/sidepanel/ui/toast'

const MCP_WARNING_LIMIT = 120 - BUILTIN_TOOL_COUNT
const MCP_NAME_PATTERN = /^[A-Za-z0-9_]+$/

type McpServerState = {
  id: string
  url: string
  headers: Record<string, string>
  name: string
  serverInfoName: string
  tools?: Array<Record<string, unknown>>
  toolSettings: Record<string, { enabled?: boolean; dangerous?: boolean }>
  error?: string
  enabled: boolean
}

export class McpConfigUi {
  private servers: McpServerState[] = []
  private expanded: Record<string, boolean> = {}
  private overLimit = false
  private readonly onToolsChanged: (tools: Array<Record<string, unknown>>) => void

  constructor(onToolsChanged: (tools: Array<Record<string, unknown>>) => void) {
    this.onToolsChanged = onToolsChanged
  }

  createTriggerButton(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      'text-xs whitespace-nowrap rounded-lg border border-bm-border-strong bg-bm-elevated text-bm-fg-muted px-2 py-1 hover:bg-bm-hover'
    const refreshLabel = () => {
      const connected = this.servers.filter((s) => s.enabled).length
      const n = this.countEnabledTools()
      btn.textContent = connected > 0 ? `MCP (${n})` : 'MCP'
    }
    refreshLabel()
    btn.addEventListener('click', () => this.openDialog(refreshLabel))
    void this.bootstrap(refreshLabel)
    return btn
  }

  private async bootstrap(refreshLabel: () => void) {
    const { mcpServers } = await chrome.storage.local.get({ mcpServers: [] })
    let reconnected: McpServerState[] = await Promise.all(
      (mcpServers as McpServerState[]).map(async (s) => {
        const result = await connectMcpServer(s.url, s.headers || {})
        return {
          ...s,
          name: s.name || this.normalizeServerName(result.name) || this.normalizeServerName(s.url) || `server_${Date.now()}`,
          serverInfoName: result.name || s.serverInfoName || '',
          tools: result.tools,
          toolSettings: this.buildToolSettings(s.toolSettings || {}, result.tools),
          error: result.error,
          enabled: !result.error,
        }
      }),
    )
    reconnected = this.ensureUniqueServerNames(reconnected)
    this.servers = reconnected
    await this.saveServers(reconnected)
    this.notifyTools(reconnected, false)
    refreshLabel()
  }

  private openDialog(refreshLabel: () => void) {
    const body = document.createElement('div')
    body.className = 'text-xs space-y-2 max-w-[720px]'

    const title = document.createElement('div')
    title.className = 'font-serif text-sm font-medium text-bm-fg-muted mb-2'
    title.textContent = 'MCP 服务器'
    body.appendChild(title)

    const render = () => {
      body.querySelectorAll('[data-mcp-dynamic]').forEach((el) => el.remove())

      for (const s of this.servers) {
        const card = document.createElement('div')
        card.setAttribute('data-mcp-dynamic', '1')
        card.className = 'border border-bm-border rounded-xl p-2 mb-2 bg-bm-muted'

        const row = document.createElement('div')
        row.className = 'flex items-center gap-2 min-w-0'
        const dot = document.createElement('span')
        dot.className = `inline-block w-2 h-2 rounded-full shrink-0 ${s.enabled ? 'bg-[#047857]' : 'bg-[var(--color-error)]'}`
        const info = document.createElement('div')
        info.className = 'flex-1 min-w-0'
        const n = document.createElement('div')
        n.className = 'text-xs font-medium truncate'
        n.textContent = s.name || s.url
        const sub = document.createElement('div')
        sub.className = 'text-xs text-bm-fg-subtle'
        const enabledTools =
          s.tools?.filter((tool) => this.getToolSetting(s, String(tool.name)).enabled !== false).length || 0
        sub.textContent = s.enabled ? `${enabledTools}/${s.tools?.length || 0} 个工具` : s.error || '未连接'
        info.append(n, sub)
        const actions = document.createElement('div')
        actions.className = 'flex gap-1 flex-shrink-0 flex-wrap justify-end'
        const btnTools = document.createElement('button')
        btnTools.type = 'button'
        btnTools.className =
          'text-xs px-2 py-0.5 rounded-lg border border-bm-border-strong bg-bm-elevated text-bm-fg-muted hover:bg-bm-hover'
        btnTools.textContent = this.expanded[s.id] ? '收起' : '工具'
        btnTools.addEventListener('click', () => {
          this.expanded[s.id] = !this.expanded[s.id]
          render()
        })
        const btnRe = document.createElement('button')
        btnRe.className =
          'text-xs px-2 py-0.5 rounded-lg border border-bm-border-strong bg-bm-elevated text-bm-fg-muted hover:bg-bm-hover'
        btnRe.textContent = '刷新'
        btnRe.addEventListener('click', async () => {
          await this.handleReconnect(s)
          render()
          refreshLabel()
        })
        const btnRm = document.createElement('button')
        btnRm.className =
          'text-xs px-2 py-0.5 rounded-lg border border-bm-border-strong bg-bm-elevated text-bm-fg-muted hover:bg-bm-hover'
        btnRm.textContent = '删除'
        btnRm.addEventListener('click', async () => {
          await this.handleRemove(s.id)
          render()
          refreshLabel()
        })
        actions.append(btnTools, btnRe, btnRm)
        row.append(dot, info, actions)
        card.appendChild(row)

        if (this.expanded[s.id] && s.tools?.length) {
          for (const tool of s.tools) {
            const tn = String(tool.name)
            const settings = this.getToolSetting(s, tn)
            const tcard = document.createElement('div')
            tcard.className = 'rounded-xl border border-bm-border p-2 mt-2 bg-bm-card'
            tcard.innerHTML = `<div class="text-xs font-medium break-all text-bm-fg">${tn}</div>
              <div class="text-xs text-bm-fg-subtle mt-1">${String(tool.description || '无描述')}</div>`
            const toggles = document.createElement('div')
            toggles.className = 'flex gap-3 mt-2 flex-wrap'
            toggles.append(
              this.makeCheckbox('启用', settings.enabled !== false, (c) =>
                this.handleToggleTool(s.id, tn, { enabled: c }),
              ),
              this.makeCheckbox('危险工具', !!settings.dangerous, (c) =>
                this.handleToggleTool(s.id, tn, { dangerous: c }, true),
              ),
            )
            tcard.appendChild(toggles)
            card.appendChild(tcard)
          }
        }
        body.appendChild(card)
      }

      const total = this.countEnabledTools()
      if (total > MCP_WARNING_LIMIT) {
        const w = document.createElement('div')
        w.setAttribute('data-mcp-dynamic', '1')
        w.className = 'text-xs text-bm-coral mb-2'
        w.textContent = `当前已启用 ${total} 个 MCP 工具。过多的工具函数可能导致调用失败，请适当调整。`
        body.appendChild(w)
      }

      const addBlock = document.createElement('div')
      addBlock.setAttribute('data-mcp-dynamic', '1')
      addBlock.className = 'border-t border-bm-border pt-2 mt-2 space-y-2'
      const nameIn = this.labeledInput('名称', 'my_server')
      const urlIn = this.labeledInput('服务器 URL', 'http://localhost:3000/mcp')
      const hdrIn = this.labeledInput('Headers (JSON, 可选)', '{"Authorization":"Bearer xx"}')
      const connectBtn = document.createElement('button')
      connectBtn.className =
        'w-full mt-2 py-2 text-sm rounded-xl border border-bm-accent bg-bm-accent text-bm-accent-fg hover:opacity-95'
      connectBtn.textContent = '连接'
      connectBtn.addEventListener('click', async () => {
        connectBtn.disabled = true
        connectBtn.textContent = '连接中...'
        await this.handleConnect(
          nameIn.input.value,
          urlIn.input.value,
          hdrIn.input.value,
          () => {
            render()
            refreshLabel()
          },
        )
        connectBtn.disabled = false
        connectBtn.textContent = '连接'
      })
      addBlock.append(nameIn.wrap, urlIn.wrap, hdrIn.wrap, connectBtn)
      body.appendChild(addBlock)
    }

    render()
    openModal(body, { title: 'MCP', widthClass: 'w-full max-w-2xl' })
  }

  private makeCheckbox(
    label: string,
    checked: boolean,
    onChange: (v: boolean) => void,
    danger?: boolean,
  ): HTMLElement {
    const lab = document.createElement('label')
    lab.className = 'flex items-center gap-1 text-xs' + (danger ? ' text-[var(--color-error)]' : '')
    const cb = document.createElement('input')
    cb.type = 'checkbox'
    cb.checked = checked
    cb.addEventListener('change', () => onChange(cb.checked))
    lab.appendChild(cb)
    lab.appendChild(document.createTextNode(label))
    return lab
  }

  private labeledInput(label: string, placeholder: string): { wrap: HTMLElement; input: HTMLInputElement } {
    const wrap = document.createElement('div')
    const l = document.createElement('label')
    l.className = 'block text-xs text-bm-fg-muted mb-0.5'
    l.textContent = label
    const input = document.createElement('input')
    input.className =
      'w-full border border-bm-border-strong rounded-xl px-2 py-1.5 text-sm box-border bg-bm-input-bg text-bm-fg'
    input.placeholder = placeholder
    wrap.append(l, input)
    return { wrap, input }
  }

  private normalizeServerName(name: unknown): string {
    const trimmed = String(name || '').trim()
    if (!trimmed) return ''
    return trimmed.replace(/[^A-Za-z0-9_]/g, '_')
  }

  private ensureUniqueServerNames(serverList: McpServerState[]): McpServerState[] {
    const used = new Set<string>()
    return serverList.map((server, index) => {
      let baseName =
        this.normalizeServerName(server.name || server.serverInfoName || `server_${index + 1}`) ||
        `server_${index + 1}`
      let nextName = baseName
      let suffix = 2
      while (used.has(nextName)) {
        nextName = `${baseName}_${suffix}`
        suffix += 1
      }
      used.add(nextName)
      return { ...server, name: nextName }
    })
  }

  private buildToolSettings(
    existingSettings: Record<string, { enabled?: boolean; dangerous?: boolean }>,
    tools: Array<Record<string, unknown>> | undefined,
  ) {
    const next: Record<string, { enabled: boolean; dangerous: boolean }> = {}
    for (const tool of tools || []) {
      const prev = existingSettings[String(tool.name)] || {}
      next[String(tool.name)] = {
        enabled: prev.enabled !== false,
        dangerous: !!prev.dangerous,
      }
    }
    return next
  }

  private getToolSetting(server: McpServerState, toolName: string) {
    return server.toolSettings?.[toolName] || { enabled: true, dangerous: false }
  }

  private countEnabledTools(): number {
    return this.servers.reduce((sum, server) => {
      if (!server.enabled || !server.tools) return sum
      return (
        sum +
        server.tools.filter((tool) => this.getToolSetting(server, String(tool.name)).enabled !== false).length
      )
    }, 0)
  }

  private notifyTools(serverList: McpServerState[], showWarning: boolean) {
    const allTools: Array<Record<string, unknown>> = []
    for (const s of serverList) {
      if (!s.enabled || !s.tools) continue
      for (const t of s.tools) {
        const settings = this.getToolSetting(s, String(t.name))
        if (settings.enabled === false) continue
        allTools.push({
          ...t,
          _serverId: s.id,
          _serverName: s.name || s.url,
          _serverUrl: s.url,
          _serverHeaders: s.headers || {},
          _dangerous: !!settings.dangerous,
          _toolCallName: buildMcpToolCallName(s.name || 'server', String(t.name)),
        })
      }
    }
    const isOverLimit = allTools.length > MCP_WARNING_LIMIT
    if (showWarning && isOverLimit && !this.overLimit) {
      toast('当前配置的 MCP 工具过多，可能导致调用失败，请适当调整。', 'info', 4000)
    }
    this.overLimit = isOverLimit
    this.onToolsChanged(allTools)
  }

  private async saveServers(serverList: McpServerState[]) {
    const toSave = serverList.map((s) => ({
      id: s.id,
      url: s.url,
      headers: s.headers,
      name: s.name,
      serverInfoName: s.serverInfoName || '',
      enabled: s.enabled,
      toolSettings: s.toolSettings || {},
    }))
    await chrome.storage.local.set({ mcpServers: toSave })
  }

  private async handleConnect(
    nameRaw: string,
    urlRaw: string,
    headersRaw: string,
    done: () => void,
  ) {
    const name = this.normalizeServerName(nameRaw)
    const url = urlRaw.trim()
    if (!name) {
      toast.error('请填写 MCP 名称')
      return
    }
    if (!MCP_NAME_PATTERN.test(name)) {
      toast.error('名称只能包含字母、数字和下划线')
      return
    }
    if (this.servers.some((server) => server.name === name)) {
      toast.error('MCP 名称不能重复')
      return
    }
    if (!url) return

    let headers: Record<string, string> = {}
    if (headersRaw.trim()) {
      try {
        headers = JSON.parse(headersRaw.trim()) as Record<string, string>
      } catch {
        toast.error('Headers JSON 格式错误')
        return
      }
    }

    const result = await connectMcpServer(url, headers)
    const server: McpServerState = {
      id: `mcp_${Date.now()}`,
      url,
      headers,
      name,
      serverInfoName: result.name || '',
      tools: result.tools,
      toolSettings: this.buildToolSettings({}, result.tools),
      error: result.error,
      enabled: !result.error,
    }
    if (result.error) toast.error(`连接失败: ${result.error}`)
    else toast.success(`已连接「${name}」(${result.tools?.length ?? 0} 个工具)`)

    const updated = [...this.servers, server]
    this.servers = this.ensureUniqueServerNames(updated)
    await this.saveServers(this.servers)
    this.notifyTools(this.servers, true)
    done()
  }

  private async handleRemove(id: string) {
    const updated = this.servers.filter((s) => s.id !== id)
    this.servers = updated
    await this.saveServers(updated)
    this.notifyTools(updated, true)
  }

  private async handleReconnect(server: McpServerState) {
    const result = await connectMcpServer(server.url, server.headers || {})
    const updated = this.servers.map((s) =>
      s.id === server.id
        ? {
            ...s,
            serverInfoName: result.name || s.serverInfoName || '',
            tools: result.tools,
            toolSettings: this.buildToolSettings(s.toolSettings || {}, result.tools),
            error: result.error,
            enabled: !result.error,
          }
        : s,
    )
    this.servers = updated
    await this.saveServers(updated)
    this.notifyTools(updated, true)
    if (result.error) toast.error(`重连失败: ${result.error}`)
    else toast.success(`已刷新「${server.name}」工具列表`)
  }

  private async handleToggleTool(serverId: string, toolName: string, patch: Record<string, unknown>, _dangerous?: boolean) {
    const updated = this.servers.map((server) =>
      server.id === serverId
        ? {
            ...server,
            toolSettings: {
              ...(server.toolSettings || {}),
              [toolName]: {
                ...this.getToolSetting(server, toolName),
                ...patch,
              },
            },
          }
        : server,
    )
    this.servers = updated
    await this.saveServers(updated)
    this.notifyTools(updated, true)
  }
}
