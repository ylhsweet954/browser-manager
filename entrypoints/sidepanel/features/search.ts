/* global chrome */

function lcs(words: string[], text: string): number {
  let res = 0
  for (let i = 0; i < words.length; i++) {
    res += text.indexOf(words[i]) >= 0 ? 1 : 0
  }
  return res
}

function formatTime(ms: number): string {
  const m = ms / 1000 / 60
  if (m < 180) return Math.ceil(m) + '分钟前'
  if (m < 24 * 60) return Math.floor(m / 60) + '小时前'
  return Math.floor(m / 60 / 24) + '天前'
}

export function mountSearch(container: HTMLElement): void {
  let filter = ''
  let curWindow: chrome.windows.Window | null = null
  let fromTabs: Array<{ tab: chrome.tabs.Tab; score: number }> = []
  let fromHistory: Array<{ history: chrome.history.HistoryItem; score: number }> = []
  let selectedIndex = 0
  const card = document.createElement('div')
  card.className = 'rounded-2xl border border-bm-border bg-bm-card p-2 shadow-whisper'

  const label = document.createElement('span')
  label.className = 'font-serif text-sm text-bm-fg-muted font-medium block mb-1'
  label.textContent = '搜索'

  const searchWrap = document.createElement('div')
  searchWrap.className = 'outline-none'
  searchWrap.tabIndex = 0

  const input = document.createElement('input')
  input.type = 'text'
  input.className =
    'w-full min-h-8 border border-bm-border-strong rounded-xl px-2 py-1 text-sm box-border bg-bm-input-bg text-bm-fg focus:outline-none focus:border-[var(--bm-focus-ring)] focus:ring-1 focus:ring-[var(--bm-focus-ring)]'
  input.placeholder = '输入关键词搜索标签页'
  input.setAttribute('aria-label', '搜索标签页')

  const listCard = document.createElement('div')
  listCard.className = 'mt-2 rounded-xl border border-bm-border overflow-hidden bg-bm-elevated'

  const ul = document.createElement('ul')
  listCard.appendChild(ul)

  searchWrap.append(input)
  card.append(label, searchWrap, listCard)
  container.appendChild(card)

  void chrome.windows.getCurrent().then((w) => {
    curWindow = w
  })

  chrome.runtime.onMessage.addListener(() => {
    void runSearch()
  })

  async function runSearch(): Promise<void> {
    const tabs = await chrome.tabs.query({})
    if (filter.length === 0) {
      fromTabs = []
      fromHistory = []
      listCard.classList.add('hidden')
      return
    }
    const arr = filter
      .toLowerCase()
      .split(' ')
      .filter((i) => i.length > 0)
    const urls = new Set<string>()
    fromTabs = tabs
      .map((tab) => ({ tab, score: lcs(arr, ((tab.url || '') + (tab.title || '')).toLowerCase()) }))
      .filter((it) => it.score > 0)
      .sort((a, b) => {
        const d = b.score - a.score
        if (d !== 0) return d
        return (b.tab.id || 0) - (a.tab.id || 0)
      })
      .slice(0, 10)
    fromTabs.forEach((it) => urls.add(it.tab.url || ''))

    const historys = await chrome.history.search({
      text: '',
      maxResults: 1000,
      startTime: Date.now() - 3 * 24 * 60 * 60 * 1000,
    })
    fromHistory = historys
      .filter((it) => !urls.has(it.url || ''))
      .map((it) => ({
        history: it,
        score: lcs(arr, ((it.url || '') + (it.title || '')).toLowerCase()),
      }))
      .filter((it) => it.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, 3)

    selectedIndex = 0
    renderList()
  }

  async function switchToItem(index: number): Promise<void> {
    const total = fromTabs.length + fromHistory.length
    if (total === 0) return
    if (index < fromTabs.length) {
      const item = fromTabs[index]
      if (curWindow && item.tab.windowId !== curWindow.id) {
        await chrome.tabs.move(item.tab.id!, { windowId: curWindow.id, index: -1 })
      }
      await chrome.tabs.update(item.tab.id!, { active: true })
    } else {
      const hIndex = index - fromTabs.length
      if (hIndex < fromHistory.length) {
        await chrome.tabs.create({ url: fromHistory[hIndex].history.url })
      }
    }
  }

  function renderList(): void {
    ul.innerHTML = ''
    const total = fromTabs.length + fromHistory.length
    if (total === 0) {
      listCard.classList.add('hidden')
      return
    }
    listCard.classList.remove('hidden')

    fromTabs.forEach((item, index) => {
      const li = document.createElement('li')
      li.className = 'font-medium border-b border-bm-border last:border-b-0'
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `w-full text-left px-1 py-1 min-h-8 rounded-lg transition-colors hover:bg-bm-hover ${
        selectedIndex === index ? 'bg-bm-hover-strong' : 'bg-bm-elevated'
      }`
      row.addEventListener('mousemove', () => {
        searchWrap.focus()
        selectedIndex = index
        renderList()
      })
      row.addEventListener('click', async () => {
        if (curWindow && item.tab.windowId !== curWindow.id) {
          await chrome.tabs.move(item.tab.id!, { windowId: curWindow.id, index: -1 })
        }
        await chrome.tabs.update(item.tab.id!, { active: true })
      })
      const inner = document.createElement('div')
      inner.className = 'flex flex-col justify-center'
      const top = document.createElement('div')
      top.className = 'flex items-center gap-1'
      const badge = document.createElement('span')
      badge.className = `text-[10px] px-2 py-0.5 rounded-lg text-bm-accent-fg shrink-0 min-w-[5rem] text-center ${
        curWindow?.id === item.tab.windowId ? 'bg-bm-accent' : 'bg-bm-fg-muted'
      }`
      badge.textContent = `${curWindow?.id === item.tab.windowId ? '当前' : '其他'}-${item.score}`
      const fav = item.tab.favIconUrl
        ? (() => {
            const img = document.createElement('img')
            img.width = 16
            img.height = 16
            img.src = item.tab.favIconUrl!
            return img
          })()
        : null
      const title = document.createElement('p')
      title.className = 'flex-1 truncate text-xs text-bm-fg'
      title.textContent = item.tab.title || ''
      top.append(badge, ...(fav ? [fav] : []), title)
      if (selectedIndex === index) {
        const close = document.createElement('span')
        close.className =
          'shrink-0 ml-1 w-5 h-5 rounded-md flex items-center justify-center bg-[var(--color-error)] hover:opacity-90 text-bm-accent-fg text-sm cursor-pointer'
        close.textContent = '×'
        close.title = '关闭此标签页'
        close.addEventListener('click', async (e) => {
          e.stopPropagation()
          await chrome.tabs.remove(item.tab.id!)
          await runSearch()
        })
        top.appendChild(close)
      }
      const url = document.createElement('p')
      url.className = 'details text-[11px] text-bm-fg-muted truncate pl-1'
      url.textContent = `url: ${item.tab.url || ''}`
      inner.append(top, url)
      row.appendChild(inner)
      li.appendChild(row)
      ul.appendChild(li)
    })

    fromHistory.forEach((item, index) => {
      const globalIndex = fromTabs.length + index
      const li = document.createElement('li')
      li.className = 'font-medium border-b border-bm-border last:border-b-0'
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `w-full text-left px-1 py-1 min-h-8 rounded-lg transition-colors hover:bg-bm-hover ${
        selectedIndex === globalIndex ? 'bg-bm-hover-strong' : 'bg-bm-elevated'
      }`
      row.addEventListener('mousemove', () => {
        selectedIndex = globalIndex
        renderList()
      })
      row.addEventListener('click', async () => {
        await chrome.tabs.create({ url: item.history.url })
      })
      const inner = document.createElement('div')
      inner.className = 'flex flex-col justify-center'
      const top = document.createElement('div')
      top.className = 'flex items-center gap-1'
      const badge = document.createElement('span')
      badge.className =
        'text-[10px] px-2 py-0.5 rounded-lg bg-bm-fg-muted text-bm-accent-fg shrink-0 min-w-[5rem] text-center'
      badge.textContent = formatTime(Date.now() - (item.history.lastVisitTime || 0))
      const title = document.createElement('p')
      title.className = 'flex-1 truncate text-xs text-bm-fg'
      title.textContent = item.history.title || ''
      top.append(badge, title)
      const url = document.createElement('p')
      url.className = 'details text-[11px] text-bm-fg-muted truncate pl-1'
      url.textContent = `url: ${item.history.url || ''}`
      inner.append(top, url)
      row.appendChild(inner)
      li.appendChild(row)
      ul.appendChild(li)
    })
  }

  input.addEventListener('input', () => {
    filter = input.value
    void runSearch()
  })

  searchWrap.addEventListener('keydown', (e) => {
    const total = fromTabs.length + fromHistory.length
    if (total === 0) return
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      selectedIndex = Math.min(selectedIndex + 1, total - 1)
      renderList()
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      selectedIndex = Math.max(selectedIndex - 1, 0)
      renderList()
    } else if (e.key === 'Enter') {
      e.preventDefault()
      void switchToItem(selectedIndex)
    } else if (e.key === 'Escape') {
      filter = ''
      input.value = ''
      void runSearch()
    } else if ((e.key === 'Delete' || e.key === 'Backspace') && e.metaKey && selectedIndex < fromTabs.length) {
      e.preventDefault()
      void chrome.tabs.remove(fromTabs[selectedIndex].tab.id!).then(() => {
        void runSearch()
      })
    }
  })

  input.focus()
}
