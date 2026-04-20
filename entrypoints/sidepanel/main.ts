import { installWarnFilter } from '@/lib/warnFilter'
import { mountApp } from '@/entrypoints/sidepanel/app'

import './style.css'
import './chat.css'

installWarnFilter()

const app = document.getElementById('app')
if (!app) {
  throw new Error('#app missing')
}
mountApp(app)

chrome.runtime.onMessage.addListener((msg) => {
  console.log('[sidepanel]', msg)
})
