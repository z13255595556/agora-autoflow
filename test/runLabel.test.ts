import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatRunLabel } from '../src/lib/runLabel.ts'

test('运行记录显示时间和状态而不是 id', () => {
  const label = formatRunLabel({
    id: 'run_ab12',
    startedAt: '2026-08-21T01:01:00.000Z',
    status: 'success',
    durationMs: 12400,
  })
  assert.equal(label.includes('run_ab12'), false)
  assert.match(label, /成功/)
})
