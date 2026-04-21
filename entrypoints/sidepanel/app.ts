import { AgentPanelController } from '@/lib/agent/AgentPanelController'
import { createSettingsButton } from '@/entrypoints/sidepanel/features/settings'
import { mountGroup } from '@/entrypoints/sidepanel/features/group'
import { mountSearch } from '@/entrypoints/sidepanel/features/search'
import { mountWorkspace } from '@/entrypoints/sidepanel/features/workspace'

export function mountApp(root: HTMLElement): void {
  root.className = 'h-full flex flex-col min-h-0 bg-white'

  const tabBar = document.createElement('div')
  tabBar.className =
    'flex shrink-0 items-center justify-between gap-2 border-b border-gray-200 bg-gray-50 px-2 py-1'

  const tabGroup = document.createElement('div')
  tabGroup.className = 'flex min-w-0 items-center gap-0.5'
  tabGroup.setAttribute('role', 'tablist')

  const btnTabs = document.createElement('button')
  btnTabs.type = 'button'
  btnTabs.className =
    'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-b-0 border-gray-200 bg-white text-gray-800 z-[2]'
  btnTabs.textContent = '标签管理'
  btnTabs.setAttribute('role', 'tab')
  btnTabs.setAttribute('aria-selected', 'true')

  const btnAgent = document.createElement('button')
  btnAgent.type = 'button'
  btnAgent.className =
    'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-transparent text-gray-500 hover:bg-gray-100 z-[1]'
  btnAgent.textContent = '小助手'
  btnAgent.setAttribute('role', 'tab')
  btnAgent.setAttribute('aria-selected', 'false')

  tabGroup.append(btnTabs, btnAgent)

  const settingsBtn = createSettingsButton()
  settingsBtn.className =
    'shrink-0 px-2.5 py-1 text-xs border border-gray-200 rounded-md bg-white text-gray-700 hover:bg-gray-50'

  tabBar.append(tabGroup, settingsBtn)

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
      btnTabs.className =
        'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-b-0 border-gray-200 bg-white text-gray-800 z-[2]'
      btnAgent.className =
        'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-transparent text-gray-500 hover:bg-gray-100 z-[1]'
    } else {
      btnAgent.className =
        'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-b-0 border-gray-200 bg-white text-gray-800 z-[2]'
      btnTabs.className =
        'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-transparent text-gray-500 hover:bg-gray-100 z-[1]'
    }
  }

  btnTabs.addEventListener('click', () => selectTab('tabs'))
  btnAgent.addEventListener('click', () => selectTab('agent'))

  selectTab('tabs')
}
