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
    'fixed inset-0 z-[150] flex items-center justify-center bg-black/40 p-3'
  backdrop.setAttribute('role', 'dialog')
  backdrop.setAttribute('aria-modal', 'true')

  const panel = document.createElement('div')
  panel.className = `bg-white rounded-lg shadow-xl max-h-[90vh] overflow-hidden flex flex-col min-w-0 ${opts.widthClass ?? 'w-full max-w-lg'}`

  if (opts.title) {
    const head = document.createElement('div')
    head.className = 'px-4 py-2 border-b border-gray-200 text-sm font-semibold text-gray-700 shrink-0'
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
