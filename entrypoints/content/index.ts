import { defineContentScript } from 'wxt/utils/define-content-script'

export default defineContentScript({
  matches: ['http://*/*', 'https://*/*'],
  runAt: 'document_idle',
  async main() {
    await import('./content-impl')
  },
})
