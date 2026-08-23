import type { SavedFlow } from './library.ts'

export type FlowListFilter = 'all' | 'schedule' | 'webhook' | 'local'

export function filterFlows(flows: SavedFlow[], q: string, filter: FlowListFilter): SavedFlow[] {
  const kw = q.trim().toLowerCase()
  return flows.filter((flow) => {
    if (kw && !flow.name.toLowerCase().includes(kw)) return false
    const kind = flow.triggerKind ?? flow.def.trigger?.kind
    if (filter === 'schedule') return kind === 'schedule'
    if (filter === 'webhook') return kind === 'webhook'
    if (filter === 'local') return flow.origin === 'local'
    return true
  })
}
