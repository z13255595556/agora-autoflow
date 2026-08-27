import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { NODE_TYPES } from '../src/registry.ts'
import type { JsonSchema, NodeType } from '../src/types.ts'

const TYPE_DESC_MAX = 16
const FIELD_DESC_MAX = 28

function fields(t: NodeType): { path: string; title?: string; description: string }[] {
  const out: { path: string; title?: string; description: string }[] = []
  for (const side of ['input', 'output'] as const) {
    const props = (t[side] as JsonSchema | undefined)?.properties ?? {}
    for (const [key, schema] of Object.entries(props)) {
      const description = schema.description
      if (description) out.push({ path: `${t.type}.${side}.${key}`, title: schema.title, description })
    }
  }
  return out
}

test('节点 description 不超过 16 字', () => {
  for (const t of NODE_TYPES) {
    const description = t.description ?? ''
    assert.ok(
      description.length <= TYPE_DESC_MAX,
      `${t.type} description ${description.length} 字：「${description}」`,
    )
  }
})

test('字段 description 不超过 28 字，且不复读 title', () => {
  for (const t of NODE_TYPES) {
    for (const f of fields(t)) {
      assert.ok(
        f.description.length <= FIELD_DESC_MAX,
        `${f.path} ${f.description.length} 字：「${f.description}」`,
      )
      if (f.title) {
        assert.ok(
          !f.description.includes(f.title),
          `${f.path} 复读了 title「${f.title}」：${f.description}`,
        )
      }
    }
  }
})

test('Inspector 重试说明不按 typeId 特判', () => {
  const src = readFileSync(new URL('../src/components/Inspector.tsx', import.meta.url), 'utf8')
  assert.equal(
    src.includes("node.data.typeId === 'http.request'"),
    false,
    'HTTP 重试去节点表单自己说，不要在 Inspector 里按 typeId 写一行',
  )
})
