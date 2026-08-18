import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dateFn, formatDate, toDate } from '../src/lib/datefn.ts'

test('business calendar is Asia/Shanghai on a UTC host', () => {
  const base = new Date('2026-08-18T00:30:00Z') // 08:30 Beijing
  assert.equal(dateFn(['now', 'yyyy-MM-dd HH:mm'], base), '2026-08-18 08:30')
  assert.equal(dateFn(['now-1d', 'yyyyMMdd'], base), '20260817')
  assert.equal(dateFn(['now/d', 'iso'], base), '2026-08-17T16:00:00.000Z')
  assert.equal(formatDate(toDate('20260818')!, 'datetime'), '2026-08-18 00:00:00')
  assert.equal(toDate('20260818')!.toISOString(), '2026-08-17T16:00:00.000Z')
  assert.equal(dateFn(['2026-08-18', 'iso'], base), '2026-08-17T16:00:00.000Z')
})
