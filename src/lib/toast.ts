export type ToastTone = 'ok' | 'warn' | 'error'

export interface Toast {
  id: string
  tone: ToastTone
  text: string
}

const MAX = 3
let seq = 0
const items: Toast[] = []
const listeners = new Set<(all: Toast[]) => void>()

function emit() {
  const snapshot = [...items]
  for (const fn of listeners) fn(snapshot)
}

export function pushToast(input: { tone: ToastTone; text: string }): string {
  const id = `t${++seq}`
  items.push({ id, tone: input.tone, text: input.text })
  while (items.length > MAX) items.shift()
  emit()
  if (typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), 4000)
  }
  return id
}

export function dismissToast(id: string) {
  const index = items.findIndex((item) => item.id === id)
  if (index < 0) return
  items.splice(index, 1)
  emit()
}

export function clearToasts() {
  items.splice(0, items.length)
  emit()
}

export function subscribeToasts(fn: (all: Toast[]) => void): () => void {
  listeners.add(fn)
  fn([...items])
  return () => { listeners.delete(fn) }
}
