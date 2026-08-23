import { test } from 'node:test'
import assert from 'node:assert/strict'
import { filterFlows } from '../src/lib/flowListFilter.ts'
import type { SavedFlow } from '../src/lib/library.ts'

const flow = (id: string, name: string, kind: 'manual' | 'schedule' | 'webhook', origin: 'local' | 'server'): SavedFlow => ({
  id,
  name,
  updatedAt: 1,
  nodeCount: 1,
  origin,
  triggerKind: kind,
  def: { id, version: 1, name, inputs: { type: 'object' }, trigger: { kind }, nodes: [], edges: [], layout: {} },
})

test('按名字和触发类型筛选', () => {
  const list = [
    flow('a', '日报', 'schedule', 'server'),
    flow('b', '回调', 'webhook', 'server'),
    flow('c', '本机日报', 'schedule', 'local'),
  ]
  assert.equal(filterFlows(list, '日', 'all').map((f) => f.id).join(','), 'a,c')
  assert.equal(filterFlows(list, '', 'webhook').map((f) => f.id).join(','), 'b')
  assert.equal(filterFlows(list, '', 'local').map((f) => f.id).join(','), 'c')
})
