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

const DEFAULT_MS = 4000

/**
 * `ms`：**带命令的提示要给够时间**。4 秒够读完"已复制"，不够读完一句
 * 「先起一个：npm run worker」再切到终端把它敲出来 —— 读一半消失的提示
 * 和没提示是一个效果。
 */
export function pushToast(input: { tone: ToastTone; text: string; ms?: number }): string {
  const id = `t${++seq}`
  items.push({ id, tone: input.tone, text: input.text })
  while (items.length > MAX) items.shift()
  emit()
  if (typeof window !== 'undefined') {
    window.setTimeout(() => dismissToast(id), input.ms ?? DEFAULT_MS)
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
