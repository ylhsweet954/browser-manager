import { AgentPanelController } from '@/lib/agent/AgentPanelController'
import { createSettingsButton } from '@/entrypoints/sidepanel/features/settings'
import { createThemeToggleButton } from '@/entrypoints/sidepanel/theme'
import { mountGroup } from '@/entrypoints/sidepanel/features/group'
import { mountSearch } from '@/entrypoints/sidepanel/features/search'
import { mountWorkspace } from '@/entrypoints/sidepanel/features/workspace'

const TAB_ACTIVE =
  'tabs-btn px-3 py-2 text-xs font-medium rounded-t-lg border border-b-0 border-bm-border-strong bg-bm-elevated text-bm-fg z-[2] shadow-whisper'
const TAB_INACTIVE =
  'tabs-btn px-3 py-2 text-xs font-medium rounded-t-lg border border-transparent text-bm-fg-muted hover:bg-bm-hover z-[1]'

export function mountApp(root: HTMLElement): void {
  root.className = 'h-full flex flex-col min-h-0 bg-bm-page'

  const tabBar = document.createElement('div')
  tabBar.className =
    'flex shrink-0 items-center justify-between gap-2 border-b border-bm-border bg-bm-toolbar backdrop-blur-md px-2 py-1.5'

  const tabGroup = document.createElement('div')
  tabGroup.className = 'flex min-w-0 items-center gap-0.5'
  tabGroup.setAttribute('role', 'tablist')

  const btnTabs = document.createElement('button')
  btnTabs.type = 'button'
  btnTabs.className = TAB_ACTIVE
  btnTabs.textContent = '标签管理'
  btnTabs.setAttribute('role', 'tab')
  btnTabs.setAttribute('aria-selected', 'true')

  const btnAgent = document.createElement('button')
  btnAgent.type = 'button'
  btnAgent.className = TAB_INACTIVE
  btnAgent.textContent = '小助手'
  btnAgent.setAttribute('role', 'tab')
  btnAgent.setAttribute('aria-selected', 'false')

  tabGroup.append(btnTabs, btnAgent)

  const right = document.createElement('div')
  right.className = 'flex shrink-0 items-center gap-1.5'
  const themeBtn = createThemeToggleButton()
  const settingsBtn = createSettingsButton()
  right.append(themeBtn, settingsBtn)

  tabBar.append(tabGroup, right)

  const panels = document.createElement('div')
  panels.className = 'flex-1 min-h-0 relative'

  const panelTabs = document.createElement('div')
  panelTabs.className = 'absolute inset-0 overflow-y-auto p-2 flex flex-col gap-2'
  panelTabs.dataset.panel = 'tabs'
  panelTabs.setAttribute('role', 'tabpanel')
  panelTabs.setAttribute('aria-hidden', 'false')

  const panelAgent = document.createElement('div')
  panelAgent.className = 'absolute inset-0 min-h-0'
  panelAgent.dataset.panel = 'agent'
  panelAgent.setAttribute('role', 'tabpanel')
  panelAgent.setAttribute('aria-hidden', 'true')
  // 使用 HTML hidden 属性而非 Tailwind .hidden，避免与 flex 等同元素类名冲突导致仍显示并拦截点击/键盘
  panelAgent.hidden = true

  mountSearch(panelTabs)
  mountGroup(panelTabs)
  mountWorkspace(panelTabs)

  panels.append(panelTabs, panelAgent)

  const wrap = document.createElement('div')
  wrap.className = 'relative flex-1 flex flex-col min-h-0 overflow-hidden'
  wrap.appendChild(tabBar)
  wrap.appendChild(panels)

  root.appendChild(wrap)

  const agent = new AgentPanelController(panelAgent)
  void agent.init()

  function selectTab(which: 'tabs' | 'agent'): void {
    const isTabs = which === 'tabs'
    panelTabs.hidden = !isTabs
    panelAgent.hidden = isTabs
    panelTabs.setAttribute('aria-hidden', String(!isTabs))
    panelAgent.setAttribute('aria-hidden', String(isTabs))
    btnTabs.setAttribute('aria-selected', String(isTabs))
    btnAgent.setAttribute('aria-selected', String(!isTabs))
    if (isTabs) {
      btnTabs.className = TAB_ACTIVE
      btnAgent.className = TAB_INACTIVE
    } else {
      btnAgent.className = TAB_ACTIVE
      btnTabs.className = TAB_INACTIVE
    }
  }

  btnTabs.addEventListener('click', () => selectTab('tabs'))
  btnAgent.addEventListener('click', () => selectTab('agent'))

  selectTab('tabs')
}
