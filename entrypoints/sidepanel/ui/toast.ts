type ToastKind = 'success' | 'error' | 'info'

let container: HTMLDivElement | null = null

function ensureContainer(): HTMLDivElement {
  if (!container) {
    container = document.createElement('div')
    container.className =
      'fixed bottom-3 left-1/2 -translate-x-1/2 z-[200] flex flex-col gap-2 pointer-events-none max-w-[90vw]'
    document.body.appendChild(container)
  }
  return container
}

function toastClass(kind: ToastKind): string {
  if (kind === 'success') return 'bm-toast bm-toast--success'
  if (kind === 'error') return 'bm-toast bm-toast--error'
  return 'bm-toast bm-toast--info'
}

export function showToast(
  message: string,
  kindOrOpts: ToastKind | { kind?: ToastKind; duration?: number } = 'info',
  durationMs?: number,
): void {
  let kind: ToastKind = 'info'
  let duration = 2800
  if (typeof kindOrOpts === 'string') {
    kind = kindOrOpts
    duration = durationMs ?? (kind === 'error' ? 4000 : 2800)
  } else if (kindOrOpts && typeof kindOrOpts === 'object') {
    kind = kindOrOpts.kind ?? 'info'
    duration = kindOrOpts.duration ?? (kind === 'error' ? 4000 : 2800)
  }
  const wrap = ensureContainer()
  const el = document.createElement('div')
  el.className = `${toastClass(kind)} pointer-events-auto`
  el.textContent = message
  wrap.appendChild(el)
  window.setTimeout(() => {
    el.remove()
  }, duration)
}

function toastFn(
  message: string,
  second?: { duration?: number } | ToastKind,
  third?: number,
): void {
  if (second === 'success' || second === 'error' || second === 'info') {
    showToast(message, second, third)
    return
  }
  showToast(message, { kind: 'info', duration: second?.duration ?? 2800 })
}

export const toast = Object.assign(toastFn, {
  success: (m: string) => showToast(m, 'success'),
  error: (m: string) => showToast(m, 'error', 4000),
})
