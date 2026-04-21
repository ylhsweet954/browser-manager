export type ModalOptions = {
  title?: string
  widthClass?: string
  onClose?: () => void
}

/** 简易模态层（替代 camel-ui Dialog） */
export function openModal(content: HTMLElement, opts: ModalOptions = {}): {
  close: () => void
} {
  const backdrop = document.createElement('div')
  backdrop.className =
    'fixed inset-0 z-[150] flex items-center justify-center p-3'
  backdrop.style.background = 'var(--bm-backdrop)'
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')

  const panel = document.createElement('div')
  panel.className = `bg-bm-elevated rounded-2xl shadow-whisper border border-bm-border max-h-[90vh] overflow-hidden flex flex-col min-w-0 ${opts.widthClass ?? 'w-full max-w-lg'}`

  if (opts.title) {
    const head = document.createElement('div')
    head.className =
      'px-4 py-3 border-b border-bm-border font-serif text-[15px] font-medium text-bm-fg shrink-0'
    head.textContent = opts.title
    panel.appendChild(head)
  }

  const body = document.createElement('div')
  body.className = 'overflow-y-auto p-4 min-h-0'
  body.appendChild(content)
  panel.appendChild(body)

  backdrop.appendChild(panel)

  const close = () => {
    opts.onClose?.()
    backdrop.remove()
    document.removeEventListener('keydown', onKey)
  }

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'Escape') close()
  }
  document.addEventListener('keydown', onKey)

  backdrop.addEventListener('click', (e) => {
    if (e.target === backdrop) close()
  })

  document.body.appendChild(backdrop)
  return { close }
}
