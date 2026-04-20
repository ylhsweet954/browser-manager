/* global chrome */
import { getDangerousToolMeta } from '@/lib/agent/dangerous-meta'
import { McpConfigUi } from '@/lib/agent/mcp-ui'
import {
  buildApiMessages,
  buildAssistantToolCallMessage,
  buildLlmErrorDisplayMessage,
  buildPlatformSystemPrompt,
  buildSessionExportMarkdown,
  buildToolResultMessages,
  formatRemainingSeconds,
  getLiveRemainingSeconds,
  loadSkillStationTools,
  loadSkillsIndexFromSkillStation,
  mergeMcpToolLists,
  normalizeScheduleStatusClass,
  formatScheduleStatus,
  replaceStreamingPlaceholder,
} from '@/lib/agent/panel-helpers'
import { createChatMessageEl, type ChatMsg } from '@/lib/agent/render-messages'
import { executeTool, streamChat } from '@/lib/api/llm'
import { resolveStoredLlmModel } from '@/lib/config/llmDefaults'
import {
  createSession,
  deleteSession,
  extractTitle,
  generateSessionId,
  listSessions,
  loadSession,
  saveSession,
} from '@/lib/api/sessions'
import {
  buildSkillsSystemPrompt,
  EMPTY_AGENT_SKILLS,
  loadAgentSkills,
  mergeAgentSkillsServerUrl,
  mergeBridgeToolDangerous,
  mergeLoadedSkills,
  saveAgentSkills,
} from '@/lib/api/skills'
import {
  analyzeRecentHistory,
  formatProfileForSystemPrompt,
  getProfileSummary,
  isProfileEnabled,
  setProfileEnabled,
} from '@/lib/api/userProfile'
import { openModal } from '@/entrypoints/sidepanel/ui/modal'
import { toast } from '@/entrypoints/sidepanel/ui/toast'

type Runtime = {
  loading: boolean
  abort: (() => void) | null
  runId: number
  pendingApproval: null | {
    runId: number
    toolCall: { name?: string; args?: Record<string, unknown> }
    approvalMeta: ReturnType<typeof getDangerousToolMeta>
  }
}

/** 小助手面板（原生 DOM，对齐原 AgentPanel.jsx 行为） */
export class AgentPanelController {
  private readonly root: HTMLElement
  private el!: {
    toolbar: HTMLElement
    sessionTitle: HTMLElement
    historyWrap: HTMLElement
    historyBtn: HTMLButtonElement
    historyDropdown: HTMLElement
    messages: HTMLElement
    messagesEnd: HTMLElement
    input: HTMLTextAreaElement
    pendingCard: HTMLElement
    inputActionsRight: HTMLElement
  }

  private sessionMessages = new Map<string, ChatMsg[]>()
  private sessionRuntime = new Map<string, Runtime>()
  private approvalResolvers = new Map<string, (v: boolean) => void>()
  private activeSessionId: string | null = null
  private sessionTitleText = ''
  private messages: ChatMsg[] = []
  private inputValue = ''
  private loading = false
  private showHistory = false
  private sessions: Array<{ id: string; title: string; updatedAt?: number }> = []
  private mcpTools: Array<Record<string, unknown>> = []
  private skillStationTools: Array<Record<string, unknown>> = []
  private agentSkills: typeof EMPTY_AGENT_SKILLS = EMPTY_AGENT_SKILLS
  private skillsLoading = false
  private platformInfo: chrome.runtime.PlatformInfo | null = null
  private pendingApproval: Runtime['pendingApproval'] = null

  private mcpUi: McpConfigUi

  constructor(root: HTMLElement) {
    this.root = root
    this.mcpUi = new McpConfigUi((tools) => {
      this.mcpTools = tools
    })
  }

  async init(): Promise<void> {
    this.buildDom()
    chrome.runtime.getPlatformInfo((info) => {
      if (chrome.runtime.lastError) return
      this.platformInfo = info
    })
    const saved = await loadAgentSkills()
    this.agentSkills = saved
    if (saved.serverUrl) {
      try {
        this.skillStationTools = await loadSkillStationTools(saved.serverUrl, saved.bridgeToolSettings)
      } catch (e) {
        console.error(e)
        this.skillStationTools = []
      }
    }
    await this.bootstrapSession()
    this.bind()
  }

  private get combinedMcpTools(): Array<Record<string, unknown>> {
    return mergeMcpToolLists(this.mcpTools, this.skillStationTools)
  }

  private buildDom(): void {
    this.root.className = 'agent-panel'
    this.root.innerHTML = ''
    const toolbar = document.createElement('div')
    toolbar.className = 'chat-toolbar'
    toolbar.innerHTML = `
      <button type="button" class="chat-toolbar-btn" data-act="new">+ 新建</button>
      <button type="button" class="chat-toolbar-btn" data-act="clear">清空</button>
      <button type="button" class="chat-toolbar-btn" data-act="export">导出</button>
      <button type="button" class="chat-toolbar-btn" data-act="schedule">调度</button>
      <span class="chat-session-title" data-session-title>新会话</span>
      <div class="chat-history-wrapper" data-history-wrap>
        <button type="button" class="chat-toolbar-btn" data-history-toggle>历史 ▼</button>
        <div class="chat-history-dropdown" data-history-dd style="display:none"></div>
      </div>
    `
    const messages = document.createElement('div')
    messages.className = 'chat-messages'
    const messagesEnd = document.createElement('div')
    messages.appendChild(messagesEnd)

    const inputArea = document.createElement('div')
    inputArea.className = 'chat-input-area'
    const pendingCard = document.createElement('div')
    pendingCard.className = 'mb-1'
    pendingCard.style.display = 'none'
    const ta = document.createElement('textarea')
    ta.rows = 3
    ta.placeholder = '输入消息... (Enter 发送, Shift+Enter 换行)'
    const actions = document.createElement('div')
    actions.className = 'chat-input-actions'
    const left = document.createElement('div')
    left.className = 'chat-input-actions-left'
    const right = document.createElement('div')
    right.className = 'chat-input-actions-right'
    actions.append(left, right)
    inputArea.append(pendingCard, ta, actions)

    left.appendChild(this.createProfileButton())
    right.appendChild(this.createSkillsButton())
    right.appendChild(this.mcpUi.createTriggerButton())
    const stopBtn = document.createElement('button')
    stopBtn.type = 'button'
    stopBtn.className = 'text-xs px-2 py-1 border rounded hidden'
    stopBtn.textContent = '停止'
    stopBtn.dataset.act = 'stop'
    const sendBtn = document.createElement('button')
    sendBtn.type = 'button'
    sendBtn.className = 'text-xs px-2 py-1 border rounded bg-blue-600 text-white'
    sendBtn.textContent = '发送'
    sendBtn.dataset.act = 'send'
    right.append(stopBtn, sendBtn)

    this.root.append(toolbar, messages, inputArea)

    this.el = {
      toolbar,
      sessionTitle: toolbar.querySelector('[data-session-title]') as HTMLElement,
      historyWrap: toolbar.querySelector('[data-history-wrap]') as HTMLElement,
      historyBtn: toolbar.querySelector('[data-history-toggle]') as HTMLButtonElement,
      historyDropdown: toolbar.querySelector('[data-history-dd]') as HTMLElement,
      messages,
      messagesEnd,
      input: ta,
      pendingCard,
      inputActionsRight: right,
    }
  }

  private bind(): void {
    this.el.toolbar.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest('[data-act]') as HTMLElement | null
      if (!t) return
      const act = t.dataset.act
      if (act === 'new') void this.handleNewSession()
      if (act === 'clear') void this.handleClearCurrentSession()
      if (act === 'export') void this.handleExportCurrentSession()
      if (act === 'schedule') this.openScheduleDialog()
    })
    this.el.historyBtn.addEventListener('click', () => {
      this.showHistory = !this.showHistory
      this.renderHistoryDropdown()
    })
    document.addEventListener('mousedown', (e) => {
      if (!this.showHistory) return
      if (!this.el.historyWrap.contains(e.target as Node)) {
        this.showHistory = false
        this.renderHistoryDropdown()
      }
    })
    this.el.input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !(e as unknown as { isComposing?: boolean }).isComposing) {
        e.preventDefault()
        void this.sendMessage()
      }
    })
    const sendBtn = this.el.inputActionsRight.querySelector('[data-act="send"]') as HTMLButtonElement
    const stopBtn = this.el.inputActionsRight.querySelector('[data-act="stop"]') as HTMLButtonElement
    sendBtn.addEventListener('click', () => void this.sendMessage())
    stopBtn.addEventListener('click', () => this.stopGeneration())
  }

  private createProfileButton(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      'text-xs whitespace-nowrap bg-gray-100 text-gray-700 border border-gray-300 rounded px-2 py-1 hover:bg-gray-200'
    btn.textContent = '画像'
    btn.addEventListener('click', () => void this.openProfileDialog())
    return btn
  }

  private async openProfileDialog(): Promise<void> {
    const body = document.createElement('div')
    body.className = 'text-xs space-y-3 max-w-[720px]'
    let enabled = await isProfileEnabled()
    let summary = await getProfileSummary()
    let analyzing = false

    const render = () => {
      body.innerHTML = ''
      const head = document.createElement('div')
      head.className = 'flex items-center justify-between gap-2 flex-wrap'
      const left = document.createElement('div')
      left.className = 'flex items-center gap-2'
      const t = document.createElement('div')
      t.className = 'text-sm font-bold text-gray-500'
      t.textContent = '浏览偏好画像'
      const analyzeBtn = document.createElement('button')
      analyzeBtn.type = 'button'
      analyzeBtn.className = 'text-[11px] text-gray-500 bg-transparent border-none cursor-pointer'
      analyzeBtn.textContent = analyzing ? '分析中…' : '↻ 立即分析'
      analyzeBtn.disabled = analyzing
      analyzeBtn.addEventListener('click', async () => {
        analyzing = true
        render()
        try {
          const updated = await analyzeRecentHistory()
          if (!updated) toast('无浏览记录或未配置 LLM', 'info')
        } catch (err) {
          toast.error('分析失败：' + ((err as Error)?.message || String(err)))
        }
        summary = await getProfileSummary()
        analyzing = false
        render()
      })
      left.append(t, analyzeBtn)
      const swLab = document.createElement('label')
      swLab.className = 'flex items-center gap-2 text-xs text-gray-500'
      const sw = document.createElement('input')
      sw.type = 'checkbox'
      sw.checked = enabled
      sw.addEventListener('change', async () => {
        enabled = sw.checked
        await setProfileEnabled(enabled)
        toast(enabled ? '画像注入已开启' : '画像注入已关闭', 'info')
      })
      swLab.append(sw, document.createTextNode(enabled ? '已开启' : '已关闭'))
      head.append(left, swLab)
      body.appendChild(head)
      if (!enabled) {
        const off = document.createElement('div')
        off.className = 'text-xs text-gray-400'
        off.textContent = '画像注入已关闭，对话不会包含画像信息。已有画像数据仍保留。'
        body.appendChild(off)
      }
      const sub = document.createElement('div')
      sub.className = 'text-xs font-semibold text-gray-500'
      sub.textContent = '当前画像'
      const box = document.createElement('div')
      box.className = 'p-3 border border-gray-200 rounded bg-gray-50 text-xs text-gray-700 max-h-64 overflow-y-auto whitespace-pre-wrap'
      box.textContent = summary || '（暂无）'
      body.append(sub, box)
    }
    render()
    openModal(body, { title: '画像', widthClass: 'w-full max-w-2xl' })
  }

  private createSkillsButton(): HTMLButtonElement {
    const btn = document.createElement('button')
    btn.type = 'button'
    btn.className =
      'text-xs whitespace-nowrap bg-gray-100 text-gray-700 border border-gray-300 rounded px-2 py-1 hover:bg-gray-200'
    const refresh = () => {
      const c = this.agentSkills.skills.length
      btn.textContent = c > 0 ? `Skills (${c})` : 'Skills'
    }
    refresh()
    btn.addEventListener('click', () => {
      const body = document.createElement('div')
      body.className = 'text-xs space-y-2 max-w-[720px]'
      body.innerHTML = `<div class="text-sm font-bold text-gray-500 mb-2">Skills</div>
        <div class="text-xs text-gray-500 mb-2">配置环境变量 \`SKILLS_DIR=/path/to/skills\`，启动 \`npx -y mcp-skill-bridge\`，默认地址 <code>http://localhost:5151/mcp</code>。</div>
        <div class="text-xs text-amber-700 mb-2">skills 功能处于测试阶段。</div>`
      const urlRow = document.createElement('div')
      const urlLab = document.createElement('label')
      urlLab.className = 'block text-xs text-gray-500 mb-0.5'
      urlLab.textContent = 'skill-bridge 地址'
      const urlIn = document.createElement('input')
      urlIn.className = 'w-full border rounded px-2 py-1.5 text-sm box-border'
      urlIn.value = this.agentSkills.serverUrl || ''
      urlIn.placeholder = 'http://localhost:5151/mcp'
      urlIn.addEventListener('input', () => {
        this.agentSkills = mergeAgentSkillsServerUrl(this.agentSkills, urlIn.value)
        void saveAgentSkills(this.agentSkills)
        this.skillStationTools = []
      })
      urlRow.append(urlLab, urlIn)
      const loadRow = document.createElement('div')
      loadRow.className = 'flex items-center justify-between gap-2 flex-wrap mt-2'
      const status = document.createElement('div')
      status.className = 'text-xs text-gray-400'
      const updateStatus = () => {
        status.textContent = this.agentSkills.loadedAt
          ? `已加载 ${this.agentSkills.skills.length} 个 skills`
          : '尚未加载 skills 索引'
      }
      updateStatus()
      const loadBtn = document.createElement('button')
      loadBtn.className = 'text-xs px-3 py-1 border rounded'
      loadBtn.textContent = 'Load'
      loadBtn.addEventListener('click', async () => {
        const serverUrl = urlIn.value.trim()
        if (!serverUrl) {
          toast.error('请先填写 skill-bridge 地址')
          return
        }
        this.skillsLoading = true
        loadBtn.disabled = true
        loadBtn.textContent = 'Loading...'
        try {
          const [loadedSkills, loadedTools] = await Promise.all([
            loadSkillsIndexFromSkillStation(serverUrl),
            loadSkillStationTools(serverUrl, this.agentSkills.bridgeToolSettings),
          ])
          const next = mergeLoadedSkills(this.agentSkills, serverUrl, loadedSkills)
          const saved = await saveAgentSkills(next)
          this.agentSkills = saved
          this.skillStationTools = loadedTools
          toast.success(`已加载 ${saved.skills.length} 个 skill`)
          refresh()
          updateStatus()
          this.renderToolRows(body, loadRow)
          renderList()
        } catch (err) {
          toast.error(`Skills 加载失败: ${(err as Error).message || String(err)}`)
        } finally {
          this.skillsLoading = false
          loadBtn.disabled = false
          loadBtn.textContent = 'Load'
        }
      })
      loadRow.append(status, loadBtn)
      body.append(urlRow, loadRow)
      this.renderToolRows(body, loadRow)
      const listHost = document.createElement('div')
      listHost.className = 'mt-3'
      body.appendChild(listHost)
      const renderList = () => {
        listHost.innerHTML = ''
        if (this.agentSkills.skills.length === 0) {
          const empty = document.createElement('div')
          empty.className = 'text-xs text-gray-400 border border-dashed rounded p-3'
          empty.textContent = '暂无已加载的 skill 索引'
          listHost.appendChild(empty)
          return
        }
        for (const skill of this.agentSkills.skills) {
          const card = document.createElement('div')
          card.className = 'rounded border border-gray-100 p-2 mb-2'
          card.innerHTML = `<div class="text-xs font-medium break-all">${skill.name || 'Unnamed Skill'}</div>
            <div class="text-xs text-gray-400 mt-1 break-all">${skill.path}</div>
            <div class="text-xs text-gray-500 mt-1">${skill.description || '无描述'}</div>`
          listHost.appendChild(card)
        }
      }
      renderList()
      openModal(body, { title: 'Skills', widthClass: 'w-full max-w-2xl' })
    })
    return btn
  }

  private renderToolRows(body: HTMLElement, after: HTMLElement): void {
    body.querySelectorAll('[data-skill-tools]').forEach((n) => n.remove())
    if (this.skillStationTools.length === 0) return
    const host = document.createElement('div')
    host.setAttribute('data-skill-tools', '1')
    host.className = 'mt-2 space-y-2'
    const t = document.createElement('div')
    t.className = 'text-xs font-medium text-gray-500'
    t.textContent = 'skill-bridge 工具'
    host.appendChild(t)
    for (const tool of this.skillStationTools) {
      const card = document.createElement('div')
      card.className = 'rounded border border-gray-100 p-2'
      card.innerHTML = `<div class="text-xs font-medium break-all">${String(tool.name)}</div>
        <div class="text-xs text-gray-400 mt-1">${String(tool.description || '无描述')}</div>`
      const cbRow = document.createElement('label')
      cbRow.className = 'flex items-center gap-1 text-xs text-red-600 mt-2'
      const cb = document.createElement('input')
      cb.type = 'checkbox'
      cb.checked = !!tool._dangerous
      cb.addEventListener('change', () => {
        const name = String(tool.name)
        this.agentSkills = mergeBridgeToolDangerous(this.agentSkills, name, cb.checked)
        void saveAgentSkills(this.agentSkills)
        void loadSkillStationTools(this.agentSkills.serverUrl, this.agentSkills.bridgeToolSettings)
          .then((tools) => {
            this.skillStationTools = tools
          })
          .catch(console.error)
      })
      cbRow.appendChild(cb)
      cbRow.appendChild(document.createTextNode('危险工具'))
      card.appendChild(cbRow)
      host.appendChild(card)
    }
    after.insertAdjacentElement('afterend', host)
  }

  private openScheduleDialog(): void {
    const body = document.createElement('div')
    body.className = 'schedule-dialog text-xs'
    let jobs: Array<Record<string, unknown>> = []
    let err = ''
    let now = Date.now()
    const clock = window.setInterval(() => {
      now = Date.now()
      renderJobs()
    }, 1000)

    const renderJobs = () => {
      body.innerHTML = `
        <div class="schedule-dialog-header">
          <div>
            <div class="schedule-dialog-title">Schedule Jobs</div>
            <div class="schedule-dialog-subtitle">显示待执行任务和最近 24 小时内的执行记录</div>
          </div>
          <div class="schedule-dialog-actions">
            <button type="button" data-ref class="text-xs px-3 py-1 border rounded bg-gray-100">刷新</button>
            <button type="button" data-clr class="text-xs px-3 py-1 border rounded bg-red-50 text-red-700">删除结束项</button>
          </div>
        </div>`
      if (err) {
        const e = document.createElement('div')
        e.className = 'schedule-dialog-error'
        e.textContent = `加载失败: ${err}`
        body.appendChild(e)
      }
      if (jobs.length === 0 && !err) {
        const e = document.createElement('div')
        e.className = 'schedule-dialog-empty'
        e.textContent = '当前没有可显示的 schedule job'
        body.appendChild(e)
      } else {
        const list = document.createElement('div')
        list.className = 'schedule-job-list'
        for (const job of jobs) {
          const card = document.createElement('div')
          card.className = 'schedule-job-card p-3 mb-2 border rounded'
          const st = String(job.status || '')
          card.innerHTML = `
            <div class="schedule-job-row">
              <span class="schedule-job-label">${String(job.label || job.toolName || '未命名任务')}</span>
              <span class="schedule-job-status schedule-job-status-${normalizeScheduleStatusClass(st)}">${formatScheduleStatus(st)}</span>
            </div>
            <div class="schedule-job-meta"><span class="schedule-job-key">ID</span><code class="schedule-job-value">${String(job.id || job.scheduleId)}</code></div>
            <div class="schedule-job-meta"><span class="schedule-job-key">预计执行时间</span><span class="schedule-job-value">${String(job.fireAt || '-')}</span></div>`
          if (st === 'pending' && typeof job.remainingSeconds === 'number') {
            const live = getLiveRemainingSeconds(job, now)
            const row = document.createElement('div')
            row.className = 'schedule-job-meta'
            row.innerHTML = `<span class="schedule-job-key">剩余时间</span><span class="schedule-job-value">${formatRemainingSeconds(live)}</span>`
            card.appendChild(row)
          }
          if (st === 'failed' && job.error) {
            const er = document.createElement('div')
            er.className = 'schedule-job-error'
            er.textContent = String(job.error)
            card.appendChild(er)
          }
          list.appendChild(card)
        }
        body.appendChild(list)
      }
      body.querySelector('[data-ref]')?.addEventListener('click', async () => {
        await load()
      })
      body.querySelector('[data-clr]')?.addEventListener('click', async () => {
        const r = await executeTool('clear_completed_scheduled', {})
        if (r?.error) toast.error(String(r.error))
        else {
          toast.success('已清理完成的 job')
          await load()
        }
      })
    }

    const load = async () => {
      try {
        const result = await executeTool('list_scheduled', {})
        if (result?.error) throw new Error(String(result.error))
        jobs = Array.isArray(result?.scheduled) ? result.scheduled : []
        err = ''
      } catch (e) {
        err = (e as Error).message || String(e)
      }
      renderJobs()
    }

    void load()
    openModal(body, {
      title: '调度',
      widthClass: 'w-full max-w-2xl',
      onClose: () => window.clearInterval(clock),
    })
  }

  private getRuntime(sid: string): Runtime {
    return (
      this.sessionRuntime.get(sid) || {
        loading: false,
        abort: null,
        runId: 0,
        pendingApproval: null,
      }
    )
  }

  private setRuntime(sid: string, patch: Partial<Runtime>): Runtime {
    const next = { ...this.getRuntime(sid), ...patch }
    this.sessionRuntime.set(sid, next)
    if (this.activeSessionId === sid) {
      this.loading = !!next.loading
      this.pendingApproval = next.pendingApproval || null
      this.renderPendingCard()
      this.updateSendStopButtons()
    }
    return next
  }

  private isCurrentRun(sid: string, runId: number): boolean {
    return this.getRuntime(sid).runId === runId
  }

  private getSessionMessages(sid: string): ChatMsg[] {
    return this.sessionMessages.get(sid) || []
  }

  private setSessionMessages(sid: string, msgs: ChatMsg[]): void {
    this.sessionMessages.set(sid, msgs)
    if (this.activeSessionId === sid) {
      this.messages = msgs
      this.renderMessages()
    }
  }

  private async bootstrapSession(): Promise<void> {
    const all = await listSessions()
    this.sessions = all
    if (all.length > 0) {
      const latest = all[0]
      const msgs = await loadSession(latest.id)
      this.sessionMessages.set(latest.id, msgs)
      this.activeSessionId = latest.id
      this.sessionTitleText = latest.title
      this.messages = msgs
    } else {
      const id = generateSessionId()
      await createSession(id, '新会话')
      this.sessionMessages.set(id, [])
      this.activeSessionId = id
      this.sessionTitleText = '新会话'
      this.messages = []
      this.sessions = await listSessions()
    }
    this.renderAll()
  }

  private renderAll(): void {
    this.el.sessionTitle.textContent = this.sessionTitleText || '新会话'
    this.renderMessages()
    this.renderHistoryDropdown()
    this.updateSendStopButtons()
  }

  private renderMessages(): void {
    this.el.messages.querySelectorAll('.chat-msg, .chat-msg-group').forEach((n) => n.remove())
    if (this.messages.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'chat-empty'
      empty.innerHTML = `<div><p>👋 你好，我是浏览器助手</p>
        <p style="margin-top:8px">我可以通过工具获取当前标签页和浏览器上下文</p>
        <p>也可以读取页面内容来回答问题</p></div>`
      this.el.messages.insertBefore(empty, this.el.messagesEnd)
      return
    }
    const empty = this.el.messages.querySelector('.chat-empty')
    empty?.remove()
    this.messages.forEach((msg, i) => {
      const node = createChatMessageEl(msg, i, {
        onRewindToUserMessage: (idx) => this.handleRewindToUserMessage(idx),
      })
      if (node) this.el.messages.insertBefore(node, this.el.messagesEnd)
    })
    if (
      this.loading &&
      this.messages.length &&
      (this.messages[this.messages.length - 1] as { content?: unknown }).content === ''
    ) {
      const row = document.createElement('div')
      row.className = 'chat-msg chat-msg-assistant'
      const b = document.createElement('div')
      b.className = 'chat-bubble chat-bubble-assistant loading-dots'
      b.textContent = '思考中'
      row.appendChild(b)
      this.el.messages.insertBefore(row, this.el.messagesEnd)
    }
    this.el.messagesEnd.scrollIntoView({ behavior: 'smooth' })
  }

  private renderHistoryDropdown(): void {
    const dd = this.el.historyDropdown
    dd.style.display = this.showHistory ? 'block' : 'none'
    this.el.historyBtn.textContent = this.showHistory ? '历史 ▲' : '历史 ▼'
    dd.innerHTML = ''
    if (this.sessions.length === 0) {
      const e = document.createElement('div')
      e.className = 'chat-history-empty'
      e.textContent = '暂无历史会话'
      dd.appendChild(e)
      return
    }
    for (const s of this.sessions) {
      const item = document.createElement('div')
      item.className = `chat-history-item ${s.id === this.activeSessionId ? 'chat-history-active' : ''}`
      const info = document.createElement('div')
      info.className = 'chat-history-item-info'
      const title = document.createElement('span')
      title.className = 'chat-history-item-title'
      title.textContent = s.title
      const rt = this.getRuntime(s.id)
      if (s.id !== this.activeSessionId && rt.pendingApproval) {
        const st = document.createElement('span')
        st.className = 'chat-history-item-status chat-history-item-status-pending'
        st.textContent = '● 待确认'
        title.appendChild(st)
      } else if (s.id !== this.activeSessionId && rt.loading) {
        const st = document.createElement('span')
        st.className = 'chat-history-item-status'
        st.textContent = '● 生成中'
        title.appendChild(st)
      }
      const time = document.createElement('span')
      time.className = 'chat-history-item-time'
      time.textContent = this.formatTime(s.updatedAt || Date.now())
      info.append(title, time)
      const del = document.createElement('button')
      del.type = 'button'
      del.className = 'chat-history-item-delete'
      del.textContent = '✕'
      del.addEventListener('click', (e) => {
        e.stopPropagation()
        void this.handleDeleteSession(s.id)
      })
      item.append(info, del)
      item.addEventListener('click', () => void this.switchSession(s.id))
      dd.appendChild(item)
    }
  }

  private formatTime(ts: number): string {
    const d = new Date(ts)
    const now = new Date()
    const isToday = d.toDateString() === now.toDateString()
    if (isToday) return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  private renderPendingCard(): void {
    const card = this.el.pendingCard
    card.innerHTML = ''
    card.style.display = 'none'
    if (!this.pendingApproval) return
    const meta =
      this.pendingApproval.approvalMeta ||
      getDangerousToolMeta(this.pendingApproval.toolCall, this.combinedMcpTools)
    if (!meta) return
    card.style.display = 'block'
    card.className = 'border border-red-200 rounded p-2 mb-1 bg-red-50/50'
    card.innerHTML = `<div class="text-xs font-semibold text-red-600 mb-1">${meta.title || '危险工具待确认'}</div>
      <div class="text-xs text-gray-600 mb-2">${meta.description || ''}</div>`
    const pre = document.createElement('pre')
    pre.className = 'tool-result-content text-xs mb-2'
    pre.textContent = JSON.stringify(
      meta.displayArgs ?? this.pendingApproval.toolCall?.args ?? {},
      null,
      2,
    )
    card.appendChild(pre)
    const row = document.createElement('div')
    row.className = 'flex justify-end gap-2'
    const cancel = document.createElement('button')
    cancel.type = 'button'
    cancel.className = 'text-xs px-2 py-1 border rounded'
    cancel.textContent = '取消'
    cancel.addEventListener('click', () => this.resolveDangerousToolApproval(false))
    const ok = document.createElement('button')
    ok.type = 'button'
    ok.className = 'text-xs px-2 py-1 border rounded bg-blue-600 text-white'
    ok.textContent = meta.confirmLabel || '确认执行'
    ok.addEventListener('click', () => this.resolveDangerousToolApproval(true))
    row.append(cancel, ok)
    card.appendChild(row)
  }

  private updateSendStopButtons(): void {
    const send = this.el.inputActionsRight.querySelector('[data-act="send"]') as HTMLButtonElement
    const stop = this.el.inputActionsRight.querySelector('[data-act="stop"]') as HTMLButtonElement
    if (this.loading) {
      send.classList.add('hidden')
      stop.classList.remove('hidden')
    } else {
      send.classList.remove('hidden')
      stop.classList.add('hidden')
    }
    send.disabled = !!this.pendingApproval
    this.el.input.disabled = this.loading || !!this.pendingApproval
  }

  private async autoSave(sid: string, msgs: ChatMsg[]): Promise<void> {
    const title = extractTitle(msgs)
    await saveSession(sid, msgs, title)
    this.sessions = await listSessions()
    if (this.activeSessionId === sid) {
      this.sessionTitleText = title
      this.el.sessionTitle.textContent = title
    }
  }

  private requestDangerousToolApproval(
    sid: string,
    runId: number,
    toolCall: { name?: string; args?: Record<string, unknown> },
    approvalMeta: ReturnType<typeof getDangerousToolMeta>,
  ): Promise<boolean> {
    return new Promise((resolve) => {
      this.approvalResolvers.set(sid, resolve)
      this.setRuntime(sid, {
        loading: false,
        abort: null,
        pendingApproval: { runId, toolCall, approvalMeta },
      })
    })
  }

  private resolveDangerousToolApproval(approved: boolean): void {
    const sid = this.activeSessionId
    if (!sid) return
    const rt = this.getRuntime(sid)
    const resolver = this.approvalResolvers.get(sid)
    this.approvalResolvers.delete(sid)
    this.setRuntime(sid, {
      pendingApproval: null,
      loading: approved && !!rt.loading ? rt.loading : false,
    })
    resolver?.(approved)
  }

  private stopSessionGeneration(sid: string): void {
    const rt = this.getRuntime(sid)
    rt.abort?.()
    const resolver = this.approvalResolvers.get(sid)
    if (resolver) {
      this.approvalResolvers.delete(sid)
      resolver(false)
    }
    this.setRuntime(sid, {
      loading: false,
      abort: null,
      runId: rt.runId + 1,
      pendingApproval: null,
    })
  }

  private stopGeneration(): void {
    if (this.activeSessionId) this.stopSessionGeneration(this.activeSessionId)
  }

  private async handleNewSession(): Promise<void> {
    const cur = this.activeSessionId
    if (cur) {
      const msgs = this.getSessionMessages(cur)
      if (msgs.length > 0) await this.autoSave(cur, msgs)
    }
    const id = generateSessionId()
    await createSession(id, '新会话')
    this.sessionMessages.set(id, [])
    this.setRuntime(id, { loading: false, abort: null, runId: 0 })
    this.activeSessionId = id
    this.sessionTitleText = '新会话'
    this.messages = []
    this.showHistory = false
    this.sessions = await listSessions()
    this.renderAll()
  }

  private async switchSession(id: string): Promise<void> {
    const cur = this.activeSessionId
    if (cur && cur !== id) {
      const msgs = this.getSessionMessages(cur)
      if (msgs.length > 0) await this.autoSave(cur, msgs)
    }
    let msgs = this.sessionMessages.get(id)
    if (!msgs) msgs = await loadSession(id)
    this.sessionMessages.set(id, msgs)
    this.activeSessionId = id
    this.sessionTitleText = this.sessions.find((s) => s.id === id)?.title || extractTitle(msgs) || '会话'
    this.messages = msgs
    const rt = this.getRuntime(id)
    this.loading = !!rt.loading
    this.pendingApproval = rt.pendingApproval || null
    this.showHistory = false
    this.renderAll()
    this.renderPendingCard()
  }

  private async handleDeleteSession(id: string): Promise<void> {
    this.stopSessionGeneration(id)
    this.sessionMessages.delete(id)
    this.sessionRuntime.delete(id)
    await deleteSession(id)
    const updated = await listSessions()
    this.sessions = updated
    if (id === this.activeSessionId) {
      if (updated.length > 0) await this.switchSession(updated[0].id)
      else await this.handleNewSession()
    } else {
      this.renderHistoryDropdown()
    }
  }

  private async buildSystemPrompt(): Promise<string> {
    const memoryBlock = await formatProfileForSystemPrompt().catch(() => '')
    const platformBlock = buildPlatformSystemPrompt(this.platformInfo)
    return (
      `You are a browser assistant running inside a browser environment.\n\n` +
      `You can use browser tools to inspect open tabs, tab groups, and windows, focus tabs and windows, move tabs between windows, open tabs, close tabs, create windows, close windows, group tabs, update groups, inspect page DOM, interact with page elements, extract page content, and search browser history.\n\n` +
      platformBlock +
      `Important rules:\n` +
      `- Do not assume you already know the current browser state. Tabs and windows can change at any time.\n` +
      `- If the user asks about open tabs, browser context, which page they are on, or any page-related question where the target tab is unclear, first call tab_list and/or tab_get_active to refresh context.\n` +
      `- If the user asks about tab groups, grouped tabs, or tab organization, first call group_list and/or group_get to refresh group context.\n` +
      `- If the user asks about windows, tab placement across windows, or moving work between windows, first call window_list and/or window_get_current to refresh context.\n` +
      `- If the user asks you to inspect, find, click, fill, style, or locate something on the current page, first use dom_query to inspect the DOM, then use dom_click, dom_set_value, dom_style, dom_get_html, or dom_highlight as needed.\n` +
      `- Use dom_highlight when it would help the user visually locate the element on the page.\n` +
      `- tab_list returns the currently open tabs with id, url, title, and capturedAt timing fields.\n` +
      `- group_list and group_get return tab group snapshots with their tabs and capturedAt timing fields.\n` +
      `- tab_get_active returns the current active tab with capturedAt timing fields.\n` +
      `- window_list and window_get_current return window snapshots with capturedAt timing fields.\n` +
      `- Use the capturedAt timing fields to judge whether tab or window information may be stale. If needed, refresh it again.\n` +
      `- If you need the actual page content, first identify the right tab, then call tab_extract.\n` +
      `- Dangerous tools such as eval_js or MCP tools marked as dangerous require explicit user confirmation before execution. The application will present that confirmation UI automatically, so do not ask the user to reply with confirmation in text.\n` +
      `- Use eval_js only when the structured DOM tools are insufficient.\n` +
      `- Some follow-up context messages may be added by the application to attach tool outputs such as screenshots. Treat them as internal tool context, not as a change in user intent.\n` +
      `- Respond in the same language as the user.` +
      buildSkillsSystemPrompt(this.agentSkills) +
      memoryBlock
    )
  }

  private async getLLMConfig(): Promise<Record<string, unknown>> {
    const { llmConfig } = await chrome.storage.local.get({
      llmConfig: {
        apiType: 'openai',
        baseUrl: '',
        apiKey: '',
        model: '',
        firstPacketTimeoutSeconds: 20,
        supportsImageInput: true,
      },
    })
    const raw = llmConfig as Record<string, unknown>
    const apiType = String(raw.apiType || 'openai')
    return {
      ...raw,
      model: resolveStoredLlmModel(apiType, raw.model as string | undefined),
      supportsImageInput: (llmConfig as { supportsImageInput?: boolean })?.supportsImageInput !== false,
    }
  }

  private async sendMessage(): Promise<void> {
    const text = this.el.input.value.trim()
    if (!text || this.loading) return
    const config = (await this.getLLMConfig()) as {
      apiKey?: string
      baseUrl?: string
      apiType?: string
      supportsImageInput?: boolean
    }
    if (!config.apiKey || !config.baseUrl) {
      toast.error('请先在设置中配置 LLM API')
      return
    }
    const sid = this.activeSessionId
    if (!sid) return
    const userMsg: ChatMsg = { role: 'user', content: text }
    const newMessages = [...this.getSessionMessages(sid), userMsg]
    this.setSessionMessages(sid, newMessages)
    this.el.input.value = ''
    const nextRunId = this.getRuntime(sid).runId + 1
    this.setRuntime(sid, { loading: true, abort: null, runId: nextRunId })
    void this.runConversation(config, sid, newMessages, nextRunId).catch((err) => {
      console.error(err)
      toast.error(`发送失败: ${(err as Error).message || String(err)}`)
      this.setRuntime(sid, { loading: false, abort: null })
    })
  }

  private async runConversation(
    config: Record<string, unknown>,
    sid: string,
    conversationMessages: ChatMsg[],
    runId: number,
  ): Promise<void> {
    if (!this.isCurrentRun(sid, runId)) return
    const systemPrompt = await this.buildSystemPrompt()
    const apiConversationMessages = buildApiMessages(config.apiType as string, conversationMessages, {
      supportsImageInput: config.supportsImageInput !== false,
    })
    const fullMessages = [{ role: 'system', content: systemPrompt }, ...apiConversationMessages]

    let streamedContent = ''
    this.setSessionMessages(sid, [...conversationMessages, { role: 'assistant', content: '', _streaming: true }])

    const abort = streamChat(
      config,
      fullMessages as never,
      {
        onText: (chunk: string) => {
          if (!this.isCurrentRun(sid, runId)) return
          streamedContent += chunk
          const prev = this.getSessionMessages(sid)
          const updated = [...prev]
          const lastIdx = updated.length - 1
          if (lastIdx >= 0 && (updated[lastIdx] as { _streaming?: boolean })._streaming) {
            updated[lastIdx] = { role: 'assistant', content: streamedContent, _streaming: true }
          }
          this.setSessionMessages(sid, updated)
        },
        onRetry: ({ nextAttempt, maxAttempts, error }: { nextAttempt: number; maxAttempts: number; error: { code?: string } }) => {
          if (!this.isCurrentRun(sid, runId)) return
          streamedContent = ''
          const prev = this.getSessionMessages(sid)
          const updated = [...prev]
          const lastIdx = updated.length - 1
          if (lastIdx >= 0 && (updated[lastIdx] as { _streaming?: boolean })._streaming) {
            updated[lastIdx] = { role: 'assistant', content: '', _streaming: true }
          }
          this.setSessionMessages(sid, updated)
          toast(`LLM 重试中 (${nextAttempt}/${maxAttempts})：${error.code || 'LLM_ERROR'}`, 'info', 1800)
        },
        onDone: async (msg: { toolCalls?: unknown[]; content?: unknown; _openaiToolCalls?: unknown }) => {
          if (!this.isCurrentRun(sid, runId)) return
          try {
            this.setRuntime(sid, { abort: null, loading: true })
            if (!msg.toolCalls) {
              const finalMessages = [...conversationMessages, { role: 'assistant', content: streamedContent }]
              this.setSessionMessages(sid, finalMessages)
              this.setRuntime(sid, { loading: false, abort: null })
              await this.autoSave(sid, finalMessages)
              return
            }
            const toolCalls = msg.toolCalls as Array<{ name?: string; args?: Record<string, unknown>; id?: string }>
            const toolNames = [...new Set(toolCalls.map((tc) => tc.name))].join(', ')
            toast(`🔧 执行: ${toolNames}`, 'info', 2000)
            const toolResults: Array<{ id?: string; name?: string; args?: unknown; result: unknown }> = []
            for (const tc of toolCalls) {
              if (!this.isCurrentRun(sid, runId)) return
              let result: unknown
              const dangerousMeta = getDangerousToolMeta(tc, this.combinedMcpTools)
              if (dangerousMeta) {
                toast(`${dangerousMeta.title}：${tc.name}`, 'info', 2500)
                const approved = await this.requestDangerousToolApproval(sid, runId, tc, dangerousMeta)
                if (!this.isCurrentRun(sid, runId)) return
                if (!approved) {
                  result = { error: 'Execution canceled by user', cancelled: true }
                } else {
                  this.setRuntime(sid, { loading: true, pendingApproval: null })
                  result = await executeTool(
                    tc.name!,
                    (dangerousMeta as { executeArgs?: unknown }).executeArgs ?? tc.args,
                    this.combinedMcpTools,
                  )
                }
              } else {
                result = await executeTool(tc.name!, tc.args, this.combinedMcpTools)
              }
              if (!this.isCurrentRun(sid, runId)) return
              toolResults.push({ id: tc.id, name: tc.name, args: tc.args, result })
            }
            if (!this.isCurrentRun(sid, runId)) return
            const assistantMsg = buildAssistantToolCallMessage(config.apiType as string, streamedContent, msg)
            const toolResultMsgs = buildToolResultMessages(toolResults)
            const continuedMessages = [...conversationMessages, assistantMsg as ChatMsg, ...toolResultMsgs]
            if (!this.isCurrentRun(sid, runId)) return
            await this.runConversation(config, sid, continuedMessages, runId)
          } catch (err) {
            if (!this.isCurrentRun(sid, runId)) return
            console.error(err)
            toast.error(`工具执行后续跑失败: ${(err as Error).message || String(err)}`)
            this.setRuntime(sid, { loading: false, abort: null })
          }
        },
        onError: (err: { message?: string }) => {
          if (!this.isCurrentRun(sid, runId)) return
          toast.error(`LLM 错误: ${err.message}`)
          const finalMessages = replaceStreamingPlaceholder(
            this.getSessionMessages(sid),
            buildLlmErrorDisplayMessage(err),
          )
          this.setSessionMessages(sid, finalMessages)
          this.setRuntime(sid, { loading: false, abort: null })
          void this.autoSave(sid, finalMessages)
        },
      } as never,
      this.combinedMcpTools as never,
      {
        sessionId: sid,
        supportsImageInput: config.supportsImageInput !== false,
      } as never,
    )

    if (!this.isCurrentRun(sid, runId)) {
      ;(abort as () => void)()
      return
    }
    this.setRuntime(sid, { abort: abort as () => void, loading: true })
  }

  private async handleClearCurrentSession(): Promise<void> {
    const sid = this.activeSessionId
    if (!sid) return
    this.stopSessionGeneration(sid)
    this.setSessionMessages(sid, [])
    this.el.input.value = ''
    this.sessionTitleText = '新会话'
    await saveSession(sid, [], '新会话')
    this.sessions = await listSessions()
    this.renderAll()
  }

  private async handleExportCurrentSession(): Promise<void> {
    const sid = this.activeSessionId
    if (!sid) return
    const currentMessages = this.getSessionMessages(sid)
    if (!currentMessages.length) {
      toast('当前会话还没有可导出的内容', 'info')
      return
    }
    const markdown = buildSessionExportMarkdown({
      title: this.sessionTitleText || '新会话',
      sessionId: sid,
      messages: currentMessages,
    })
    const blob = new Blob([markdown], { type: 'text/markdown;charset=utf-8' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `${sid}.md`
    a.click()
    URL.revokeObjectURL(url)
    toast.success(`已导出 ${sid}.md`)
  }

  private handleRewindToUserMessage(index: number): void {
    const sid = this.activeSessionId
    if (!sid || index < 0) return
    const msgs = this.getSessionMessages(sid)
    if (index >= msgs.length) return
    const target = msgs[index]
    if (target?.role !== 'user' || Array.isArray(target.content)) return
    const text = typeof target.content === 'string' ? target.content : String(target.content ?? '')
    this.stopSessionGeneration(sid)
    const truncated = msgs.slice(0, index)
    this.setSessionMessages(sid, truncated)
    this.el.input.value = text
    void this.autoSave(sid, truncated)
  }
}
