import { test } from 'node:test'
import assert from 'node:assert/strict'
import { closeOwned, type ReferenceTarget } from '../src/lib/referencePicker.ts'

const opened = (owner: string): ReferenceTarget =>
  ({ owner, nodeId: 'n3', query: '', mixed: false, replace: () => {} })

test('字段卸载时收起自己开的那一次', () => {
  // 关掉节点编辑侧栏 = 字段被卸载。面板挂在应用根上，得靠这一步跟着走
  assert.equal(closeOwned(opened('field-a'), 'field-a'), null)
})

test('别人开的面板不会被误关', () => {
  const b = opened('field-b')
  assert.equal(closeOwned(b, 'field-a'), b)
})

test('面板本来就没开，卸载时是空操作', () => {
  assert.equal(closeOwned(null, 'field-a'), null)
})
