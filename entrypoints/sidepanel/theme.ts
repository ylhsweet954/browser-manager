/* global chrome */

export type ThemeMode = 'light' | 'dark'

const STORAGE_KEY = 'uiTheme'

export function getAppliedTheme(): ThemeMode {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light'
}

export function applyTheme(mode: ThemeMode): void {
  document.documentElement.dataset.theme = mode
}

export async function initTheme(): Promise<void> {
  const { [STORAGE_KEY]: stored } = await chrome.storage.local.get({ [STORAGE_KEY]: 'light' as ThemeMode })
  applyTheme(stored === 'dark' ? 'dark' : 'light')
}

export async function setTheme(mode: ThemeMode): Promise<void> {
  applyTheme(mode)
  await chrome.storage.local.set({ [STORAGE_KEY]: mode })
}

export async function toggleTheme(): Promise<void> {
  await setTheme(getAppliedTheme() === 'dark' ? 'light' : 'dark')
}

export function createThemeToggleButton(): HTMLButtonElement {
  const btn = document.createElement('button')
  btn.type = 'button'
  btn.className =
    'bm-theme-toggle shrink-0 px-2.5 py-1 text-xs rounded-lg border transition-colors'
  btn.title = '切换浅色 / 深色主题'
  btn.setAttribute('aria-label', '切换主题')

  const refresh = () => {
    const dark = getAppliedTheme() === 'dark'
    btn.textContent = dark ? '浅色' : '深色'
    btn.setAttribute('aria-pressed', dark ? 'true' : 'false')
  }

  refresh()
  btn.addEventListener('click', () => {
    void toggleTheme().then(refresh)
  })

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[STORAGE_KEY]) {
      const v = changes[STORAGE_KEY].newValue
      if (v === 'light' || v === 'dark') {
        applyTheme(v)
        refresh()
      }
    }
  })

  return btn
}
