/* global chrome */
import { toast } from '@/entrypoints/sidepanel/ui/toast'

const GROUP_COLORS = ['blue', 'red', 'yellow', 'green', 'pink', 'purple', 'cyan', 'orange', 'grey'] as const

export function mountGroup(container: HTMLElement): void {
  const card = document.createElement('div')
  card.className = 'rounded-2xl border border-bm-border bg-bm-card p-2 shadow-whisper'

  const label = document.createElement('span')
  label.className = 'font-serif text-sm text-bm-fg-muted font-medium block mb-1'
  label.textContent = '分组'

  const row = document.createElement('div')
  row.className = 'flex gap-1 mb-2'

  const input = document.createElement('input')
  input.className =
    'flex-1 min-h-8 border border-bm-border-strong rounded-xl px-2 py-1 text-sm box-border bg-bm-input-bg text-bm-fg focus:outline-none focus:ring-1 focus:ring-[var(--bm-focus-ring)]'
  input.placeholder = '分组名#url正则'
  input.setAttribute('aria-label', '分组规则')

  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className =
    'text-xs whitespace-nowrap shrink-0 px-2 py-1.5 rounded-lg border border-bm-border-strong bg-bm-elevated text-bm-fg-muted hover:bg-bm-hover'
  btn.textContent = '分组'

  row.append(input, btn)

  const row2 = document.createElement('div')
  row2.className = 'flex gap-1 items-center flex-wrap'

  const mkBtn = (t: string, onClick: () => void) => {
    const b = document.createElement('button')
    b.type = 'button'
    b.className =
      'flex-1 min-w-[4rem] text-xs px-1 py-1.5 rounded-lg border border-bm-border-strong bg-bm-elevated text-bm-fg-muted hover:bg-bm-hover'
    b.textContent = t
    b.addEventListener('click', () => void onClick())
    return b
  }

  row2.append(
    mkBtn('域名分组', () => void autoGroupByDomain()),
    mkBtn('折叠所有', () => void collapseAllGroups()),
    mkBtn('取消分组', () => void ungroupAll()),
  )

  card.append(label, row, row2)
  container.appendChild(card)

  async function triggerGroup(): Promise<void> {
    const groupRule = input.value
    const m = groupRule.match(/^((.+)#)?(.+)$/)
    if (m) {
      const groupName = m[2] ? m[2] : m[3]
      const regex = new RegExp(m[3])
      let tabs = await chrome.tabs.query({})
      tabs = tabs.filter((item) => item.url && regex.test(item.url))
      if (tabs.length <= 0) {
        toast.error('没有符合条件的tabs')
        return
      }
      const groups = await chrome.tabGroups.query({ title: groupName })
      let groupId: number
      if (groups && groups.length) {
        groupId = groups[0].id!
        await chrome.tabs.group({ groupId, tabIds: tabs.map((it) => it.id!) })
      } else {
        groupId = await chrome.tabs.group({ tabIds: tabs.map((it) => it.id!) })
        await chrome.tabGroups.update(groupId, { title: groupName })
      }
    } else {
      toast.error('输入不合法~')
    }
  }

  async function autoGroupByDomain(): Promise<void> {
    const tabs = await chrome.tabs.query({})
    const httpTabs = tabs.filter((t) => t.url && t.url.startsWith('http'))
    const domainMap: Record<string, number[]> = {}
    for (const tab of httpTabs) {
      try {
        const hostname = new URL(tab.url!).hostname
        if (!domainMap[hostname]) domainMap[hostname] = []
        domainMap[hostname].push(tab.id!)
      } catch {
        /* ignore */
      }
    }
    let colorIdx = 0
    let groupCount = 0
    for (const [domain, tabIds] of Object.entries(domainMap)) {
      if (tabIds.length < 2) continue
      const existing = await chrome.tabGroups.query({ title: domain })
      let groupId: number
      if (existing && existing.length) {
        groupId = existing[0].id!
        await chrome.tabs.group({ groupId, tabIds })
      } else {
        groupId = await chrome.tabs.group({ tabIds })
        await chrome.tabGroups.update(groupId, {
          title: domain,
          color: GROUP_COLORS[colorIdx % GROUP_COLORS.length],
        })
        colorIdx++
      }
      groupCount++
    }
    if (groupCount > 0) toast.success(`已按域名创建 ${groupCount} 个分组`)
    else toast('没有可分组的标签页（至少需要同域名 2 个以上）', 'info')
  }

  async function collapseAllGroups(): Promise<void> {
    const groups = await chrome.tabGroups.query({})
    for (const g of groups) {
      await chrome.tabGroups.update(g.id, { collapsed: true })
    }
    toast.success(`已折叠 ${groups.length} 个分组`)
  }

  async function ungroupAll(): Promise<void> {
    const tabs = await chrome.tabs.query({})
    const groupedTabs = tabs.filter((t) => t.groupId != null && t.groupId !== -1)
    if (groupedTabs.length === 0) {
      toast('没有已分组的标签页', 'info')
      return
    }
    for (const tab of groupedTabs) {
      await chrome.tabs.ungroup(tab.id!)
    }
    toast.success(`已取消 ${groupedTabs.length} 个标签的分组`)
  }

  btn.addEventListener('click', () => void triggerGroup())
}
