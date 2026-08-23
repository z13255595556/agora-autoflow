import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pushToast, subscribeToasts, clearToasts } from '../src/lib/toast.ts'

test('toast 订阅能收到推送，最多留 3 条', () => {
  clearToasts()
  const seen: string[] = []
  const stop = subscribeToasts((all) => { seen.splice(0, seen.length, ...all.map((t) => t.text)) })
  pushToast({ tone: 'ok', text: 'a' })
  pushToast({ tone: 'ok', text: 'b' })
  pushToast({ tone: 'ok', text: 'c' })
  pushToast({ tone: 'ok', text: 'd' })
  stop()
  assert.deepEqual(seen, ['b', 'c', 'd'])
  clearToasts()
})
