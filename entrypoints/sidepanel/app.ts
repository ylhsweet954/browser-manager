import { AgentPanelController } from '@/lib/agent/AgentPanelController'
import { createSettingsButton } from '@/entrypoints/sidepanel/features/settings'
import { mountGroup } from '@/entrypoints/sidepanel/features/group'
import { mountSearch } from '@/entrypoints/sidepanel/features/search'
import { mountWorkspace } from '@/entrypoints/sidepanel/features/workspace'

export function mountApp(root: HTMLElement): void {
  root.className = 'h-full flex flex-col min-h-0 bg-white'

  const settingsFloat = document.createElement('div')
  settingsFloat.className = 'absolute top-1.5 right-2 z-[100]'
  settingsFloat.appendChild(createSettingsButton())

  const tabBar = document.createElement('div')
  tabBar.className = 'flex shrink-0 border-b border-gray-200 bg-gray-50 px-1 pt-1 gap-0.5'

  const btnTabs = document.createElement('button')
  btnTabs.type = 'button'
  btnTabs.className =
    'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-b-0 border-gray-200 bg-white text-gray-800 z-[2]'
  btnTabs.textContent = '标签管理'

  const btnAgent = document.createElement('button')
  btnAgent.type = 'button'
  btnAgent.className =
    'tabs-btn px-3 py-1.5 text-xs font-medium rounded-t border border-transparent text-gray-500 hover:bg-gray-100 z-[1]'
  btnAgent.textContent = '小助手'

  tabBar.append(btnTabs, btnAgent)

  const panels = document.createElement('div')
  panels.className = 'flex-1 min-h-0 relative'

  const panelTabs = document.createElement('div')
  panelTabs.className = 'absolute inset-0 overflow-y-auto p-2 flex flex-col gap-2'
  panelTabs.dataset.panel = 'tabs'

  const panelAgent = document.createElement('div')
  panelAgent.className = 'absolute inset-0 min-h-0 hidden'
  panelAgent.dataset.panel = 'agent'

  mountSearch(panelTabs)
  mountGroup(panelTabs)
  mountWorkspace(panelTabs)

  panels.append(panelTabs, panelAgent)

  const wrap = document.createElement('div')
  wrap.className = 'relative flex-1 flex flex-col min-h-0 overflow-hidden'
  wrap.appendChild(settingsFloat)
  wrap.appendChild(tabBar)
  wrap.appendChild(panels)

  root.appendChild(wrap)

  const agent = new AgentPanelController(panelAgent)
  void agent.init()

  function selectTab(which: 'tabs' | 'agent'): void {
    const isTabs = which === 'tabs'
    panelTabs.classList.toggle('hidden', !isTabs)
    panelAgent.classList.toggle('hidden', isTabs)
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
