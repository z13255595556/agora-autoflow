import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chipClickIntent } from '../src/components/chipDom.ts'

test('单击开取值面板，连点第二次展开成表达式', () => {
  assert.equal(chipClickIntent(1), 'pick')
  assert.equal(chipClickIntent(2), 'expand')
  assert.equal(chipClickIntent(3), 'expand')
})
