import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TEMPLATES } from '../src/lib/templates.ts'

test('recipe 模板至少两个节点且有边', () => {
  for (const t of TEMPLATES.filter((item) => item.kind === 'recipe')) {
    const def = t.build()
    assert.ok(def.nodes.length >= 2, t.key)
    assert.ok(def.edges.length >= 1, t.key)
  }
})

test('blank 模板只有触发器', () => {
  for (const t of TEMPLATES.filter((item) => item.kind === 'blank')) {
    const def = t.build()
    assert.equal(def.nodes.length, 1, t.key)
    assert.equal(def.edges.length, 0, t.key)
    assert.ok(def.nodes[0].type.startsWith('trigger.'), t.key)
  }
})
