/* global chrome */
import { toast } from '@/entrypoints/sidepanel/ui/toast'

type Workspace = {
  id: string
  name: string
  createdAt: number
  tabs: Array<{ url: string; title?: string; favIconUrl?: string }>
}

export function mountWorkspace(container: HTMLElement): void {
  const card = document.createElement('div')
  card.className = 'rounded-lg border border-gray-200 bg-white p-2 shadow-sm'

  const head = document.createElement('div')
  head.className = 'flex justify-between items-center pb-1 mb-1 border-b border-dashed border-gray-300'

  const label = document.createElement('span')
  label.className = 'text-sm text-gray-500 font-bold'
  label.textContent = '工作区'

  const toggleSave = document.createElement('button')
  toggleSave.type = 'button'
  toggleSave.className = 'w-24 text-xs px-2 py-1 border rounded bg-white hover:bg-gray-50'

  const savePanel = document.createElement('div')
  savePanel.className = 'hidden flex gap-1 mb-2'

  const nameInput = document.createElement('input')
  nameInput.className =
    'flex-1 min-h-8 border border-gray-300 rounded px-2 py-1 text-sm box-border focus:border-blue-500 focus:outline-none'
  nameInput.placeholder = '输入工作区名称'
  nameInput.setAttribute('aria-label', '工作区名称')

  const saveBtn = document.createElement('button')
  saveBtn.type = 'button'
  saveBtn.className = 'text-xs whitespace-nowrap shrink-0 px-2 py-1 border rounded bg-white hover:bg-gray-50'
  saveBtn.textContent = '保存'

  savePanel.append(nameInput, saveBtn)

  const listHost = document.createElement('div')
  listHost.className = 'max-h-40 overflow-y-auto'

  head.append(label, toggleSave)
  card.append(head, savePanel, listHost)
  container.appendChild(card)

  let showSave = false
  let restoringId: string | null = null
  let confirmDeleteId: string | null = null

  const formatDate = (ts: number) => {
    const d = new Date(ts)
    return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }

  async function loadWorkspaces(): Promise<Workspace[]> {
    const { workspaces: ws } = await chrome.storage.local.get({ workspaces: [] })
    return Array.isArray(ws) ? ws : []
  }

  async function render(): Promise<void> {
    const workspaces = await loadWorkspaces()
    listHost.innerHTML = ''
    toggleSave.textContent = showSave ? '取消' : '保存当前'
    savePanel.classList.toggle('hidden', !showSave)

    if (workspaces.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'text-xs text-gray-400 text-center py-2'
      empty.textContent = '暂无保存的工作区'
      listHost.appendChild(empty)
      return
    }

    for (const ws of workspaces) {
      const row = document.createElement('div')
      row.className = 'flex items-center justify-between py-1 px-1 hover:bg-gray-100 rounded text-xs'

      const info = document.createElement('div')
      info.className = 'flex-1 truncate'
      info.innerHTML = `<span class="font-bold">${ws.name}</span><span class="text-gray-400 ml-1">${ws.tabs.length} 个标签 · ${formatDate(ws.createdAt)}</span>`

      const actions = document.createElement('div')
      actions.className = 'flex gap-1 shrink-0'

      const restoreBtn = document.createElement('button')
      restoreBtn.type = 'button'
      restoreBtn.className = 'text-xs px-2 py-0.5 min-h-6 border rounded'
      restoreBtn.textContent = restoringId === ws.id ? '恢复中...' : '恢复'
      restoreBtn.disabled = restoringId === ws.id
      restoreBtn.addEventListener('click', () => void restoreWorkspace(ws))

      const delBtn = document.createElement('button')
      delBtn.type = 'button'
      delBtn.className = 'text-xs px-2 py-0.5 min-h-6 border rounded'

      if (confirmDeleteId === ws.id) {
        const ok = document.createElement('button')
        ok.type = 'button'
        ok.className = 'text-xs px-2 py-0.5 min-h-6 border rounded bg-red-500 text-white'
        ok.textContent = '确认'
        ok.addEventListener('click', () => void deleteWorkspace(ws.id))
        const cancel = document.createElement('button')
        cancel.type = 'button'
        cancel.className = 'text-xs px-2 py-0.5 min-h-6 border rounded'
        cancel.textContent = '取消'
        cancel.addEventListener('click', () => {
          confirmDeleteId = null
          void render()
        })
        actions.append(restoreBtn, ok, cancel)
      } else {
        delBtn.textContent = '删除'
        delBtn.addEventListener('click', () => {
          confirmDeleteId = ws.id
          void render()
        })
        actions.append(restoreBtn, delBtn)
      }

      row.append(info, actions)
      listHost.appendChild(row)
    }
  }

  async function saveWorkspace(): Promise<void> {
    const name = nameInput.value.trim()
    if (!name) {
      toast.error('请输入工作区名称')
      return
    }
    const tabs = await chrome.tabs.query({})
    const httpTabs = tabs.filter((t) => t.url && t.url.startsWith('http'))
    if (httpTabs.length === 0) {
      toast.error('没有可保存的标签页')
      return
    }
    const ws: Workspace = {
      id: 'ws_' + Date.now(),
      name,
      createdAt: Date.now(),
      tabs: httpTabs.map((t) => ({ url: t.url!, title: t.title, favIconUrl: t.favIconUrl || '' })),
    }
    const { workspaces: existing } = await chrome.storage.local.get({ workspaces: [] })
    const arr = Array.isArray(existing) ? existing : []
    arr.unshift(ws)
    await chrome.storage.local.set({ workspaces: arr })
    toast.success(`已保存工作区「${name}」(${httpTabs.length} 个标签)`)
    showSave = false
    nameInput.value = ''
    void render()
  }

  async function restoreWorkspace(ws: Workspace): Promise<void> {
    restoringId = ws.id
    void render()
    try {
      const openTabs = await chrome.tabs.query({})
      const openUrls = new Set(openTabs.map((t) => t.url && t.url.split('#')[0]))

      let opened = 0
      let skipped = 0
      for (const tab of ws.tabs) {
        const urlBase = tab.url.split('#')[0]
        if (openUrls.has(urlBase)) {
          skipped++
          continue
        }
        await chrome.tabs.create({ url: tab.url, active: false })
        openUrls.add(urlBase)
        opened++
      }

      if (opened > 0 && skipped > 0) toast.success(`已恢复 ${opened} 个标签，跳过 ${skipped} 个已打开的`)
      else if (opened > 0) toast.success(`已恢复「${ws.name}」(${opened} 个标签)`)
      else toast('所有标签页都已经打开了，无需恢复', 'info')
    } finally {
      restoringId = null
      void render()
    }
  }

  async function deleteWorkspace(id: string): Promise<void> {
    const { workspaces: existing } = await chrome.storage.local.get({ workspaces: [] })
    const arr = (Array.isArray(existing) ? existing : []).filter((w: Workspace) => w.id !== id)
    await chrome.storage.local.set({ workspaces: arr })
    confirmDeleteId = null
    toast.success('已删除')
    void render()
  }

  toggleSave.addEventListener('click', () => {
    showSave = !showSave
    void render()
  })
  saveBtn.addEventListener('click', () => void saveWorkspace())

  void render()
}
