import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 调度器的端到端测试。**需要真的 Postgres。**
 *
 *   DATABASE_URL=... node --test --experimental-strip-types test/scheduler.test.ts
 *
 * 第一条是回归测试，钉的是一个真出现过的 bug：syncAllSchedules 每个 tick 都跑，
 * 无条件重算 next_fire_at 会把它一直推到未来 —— **定时永远不会触发**，
 * 而症状极其隐蔽：心跳正常、排程行在、next_fire_at 看着完全合理。
 */

const SKIP = !process.env.DATABASE_URL
if (SKIP) test('跳过：没有 DATABASE_URL，调度器测试需要真的 Postgres', () => {})

let pool: import('pg').Pool
let runSchedulerTick: (now?: Date) => Promise<number>
let syncSchedule: (flowId: string, cron: string | null, tz: string, now?: Date) => Promise<void>
let flowId: string

const DEF = (id: string) => ({
  id, version: 1, name: 'sched test',
  inputs: { type: 'object' as const, properties: {} },
  trigger: { kind: 'schedule' as const, mode: 'daily', at: '09:00' },
  nodes: [{ id: 't', type: 'trigger.schedule', typeVersion: '1.0.0', name: '每天', params: {}, onError: 'fail' as const }],
  edges: [], layout: { t: { x: 0, y: 0 } },
})

before(async () => {
  if (SKIP) return
  const store = await import('../worker/store.ts')
  const sched = await import('../worker/scheduler.ts')
  pool = store.pool
  runSchedulerTick = sched.runSchedulerTick
  syncSchedule = sched.syncSchedule

  flowId = `stest_${Math.random().toString(36).slice(2, 10)}`
  const def = DEF(flowId)
  await pool.query('INSERT INTO flows (id, name, draft, active_version) VALUES ($1,$2,$3,1)', [flowId, def.name, JSON.stringify(def)])
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)', [flowId, JSON.stringify(def)])
})

after(async () => {
  if (SKIP) return
  await pool.query('DELETE FROM runs WHERE flow_id = $1', [flowId])
  await pool.query('DELETE FROM flow_versions WHERE flow_id = $1 AND version < 0', [flowId])
  await pool.query('DELETE FROM schedules WHERE flow_id = $1', [flowId])
  await pool.query('DELETE FROM flows WHERE id = $1', [flowId])
  await pool.end()
})

const nextFire = async () => {
  const { rows } = await pool.query('SELECT next_fire_at, last_fire_at FROM schedules WHERE flow_id = $1', [flowId])
  return rows[0]
}
const runCount = async () => {
  const { rows } = await pool.query("SELECT count(*)::int AS n FROM runs WHERE flow_id = $1 AND trigger_kind='schedule'", [flowId])
  return rows[0].n as number
}

test('★★ 反复 sync 不会把 next_fire_at 一直往后推', { skip: SKIP }, async () => {
  // 这是那个 bug 的回归测试。无条件重算的话，syncAllSchedules 每秒跑一次，
  // 每次都把下次触发推到"现在之后"，于是它永远不会到期
  await syncSchedule(flowId, '0 9 * * *', 'Asia/Shanghai')
  const first = (await nextFire()).next_fire_at

  for (let i = 0; i < 3; i++) await syncSchedule(flowId, '0 9 * * *', 'Asia/Shanghai')
  const after = (await nextFire()).next_fire_at

  assert.equal(after.getTime(), first.getTime(), '★ 配置没变就不许动 next_fire_at')
})

test('改了 cron 才重算下次触发', { skip: SKIP }, async () => {
  await syncSchedule(flowId, '0 9 * * *', 'Asia/Shanghai')
  const before = (await nextFire()).next_fire_at
  await syncSchedule(flowId, '30 14 * * *', 'Asia/Shanghai')
  const after = (await nextFire()).next_fire_at
  assert.notEqual(after.getTime(), before.getTime(), '换了表达式就该按新的算')
})

test('改了时区也重算', { skip: SKIP }, async () => {
  await syncSchedule(flowId, '0 9 * * *', 'Asia/Shanghai')
  const before = (await nextFire()).next_fire_at
  await syncSchedule(flowId, '0 9 * * *', 'UTC')
  const after = (await nextFire()).next_fire_at
  assert.notEqual(after.getTime(), before.getTime())
})

test('★ 到期就入队，且 scheduled_time 写的是计划时刻不是当下', { skip: SKIP }, async () => {
  // scheduled_time 是日期基准：补跑昨天 9 点的日报时，
  // date('now-1d') 必须算出"相对那个计划时刻的昨天"
  const due = new Date(Date.now() - 10_000)
  await pool.query('UPDATE schedules SET next_fire_at = $2 WHERE flow_id = $1', [flowId, due])

  const fired = await runSchedulerTick(new Date())
  assert.equal(fired, 1)

  const { rows } = await pool.query(
    "SELECT scheduled_time, mode, trigger_kind FROM runs WHERE flow_id=$1 AND trigger_kind='schedule'", [flowId])
  assert.equal(rows.length, 1)
  assert.equal(rows[0].mode, 'production', '定时触发一律 production —— 忽略 pinData')
  assert.equal(Math.abs(rows[0].scheduled_time.getTime() - due.getTime()) < 1000, true, '写的是计划时刻')
})

test('★ 同一个计划时刻不会重复入队（唯一约束兜底）', { skip: SKIP }, async () => {
  // 锁是性能优化，约束才是正确性保证：即使两个调度器同时扫，第二次也插不进去
  const due = new Date(Date.now() - 10_000)
  const before = await runCount()
  await pool.query('UPDATE schedules SET next_fire_at = $2 WHERE flow_id = $1', [flowId, due])
  await runSchedulerTick(new Date())
  await pool.query('UPDATE schedules SET next_fire_at = $2 WHERE flow_id = $1', [flowId, due])
  await runSchedulerTick(new Date())
  assert.equal(await runCount(), before + 1, '同一个 scheduled_time 只该有一条')
})

test('★ 迟到超过 grace 就不补跑，直接排下一次', { skip: SKIP }, async () => {
  // 机器停了一整天，恢复后不该把错过的全补一遍（会连发一堆），
  // 但也不该一次都不补 —— 只补最近的、且在宽限期内的那一次
  const before = await runCount()
  const longAgo = new Date(Date.now() - 3 * 3600_000)   // 3 小时前，grace 默认 1 小时
  await pool.query(
    'UPDATE schedules SET next_fire_at = $2, misfire = $3 WHERE flow_id = $1',
    [flowId, longAgo, 'fire_once'])
  await runSchedulerTick(new Date())
  assert.equal(await runCount(), before, '超出宽限期，这一次放弃')

  const nf = (await nextFire()).next_fire_at
  assert.ok(nf.getTime() > Date.now(), '但下次触发要排好，不能卡在过去')
})

test('未发布的流程不排程（草稿改坏了不该影响线上）', { skip: SKIP }, async () => {
  await pool.query('UPDATE flows SET active_version = NULL WHERE id = $1', [flowId])
  const before = await runCount()
  await pool.query('UPDATE schedules SET next_fire_at = now() - interval \'10 seconds\' WHERE flow_id = $1', [flowId])
  await runSchedulerTick(new Date())
  assert.equal(await runCount(), before)
  await pool.query('UPDATE flows SET active_version = 1 WHERE id = $1', [flowId])
})

test('停用的排程不触发', { skip: SKIP }, async () => {
  const before = await runCount()
  await pool.query(
    "UPDATE schedules SET enabled = false, next_fire_at = now() - interval '10 seconds' WHERE flow_id = $1", [flowId])
  await runSchedulerTick(new Date())
  assert.equal(await runCount(), before)
  await pool.query('UPDATE schedules SET enabled = true WHERE flow_id = $1', [flowId])
})

test('★★ 已停止的流程：不触发，但 next_fire_at 照常推进（恢复后不补跑）', { skip: SKIP }, async () => {
  // 卡片开关（flows.paused_at，016 迁移）。钉住"只推进不触发"这半边：
  // 图省事在 WHERE 里过滤掉已停止流程的话，next_fire_at 会冻在过去，
  // 重新启用的一瞬间它就"到期"—— misfire=fire_once 加一小时 grace 会立刻
  // 补跑一发根本没人错过的运行。停止一条流程常常正是因为它在刷屏，
  // "一启用先自己跑一次"是最糟的欢迎仪式
  const before = await runCount()
  await pool.query('UPDATE flows SET paused_at = now() WHERE id = $1', [flowId])
  await pool.query(
    "UPDATE schedules SET next_fire_at = now() - interval '10 seconds', misfire = 'fire_once' WHERE flow_id = $1",
    [flowId])
  await runSchedulerTick(new Date())
  assert.equal(await runCount(), before, '停着就一次都不跑')

  const nf = await nextFire()
  assert.ok(nf.next_fire_at.getTime() > Date.now(), '★ 时刻必须推进到未来，不许冻在过去')

  // 恢复后立刻再扫一轮：next_fire_at 已在未来，什么都不该发生
  await pool.query('UPDATE flows SET paused_at = NULL WHERE id = $1', [flowId])
  await runSchedulerTick(new Date())
  assert.equal(await runCount(), before, '恢复不补跑，从下一个正常时点开始')
})

test('★★ 改了草稿不发布：定时跑的仍是已发布那一版', { skip: SKIP }, async () => {
  // 这是整件事的验收核心。手动运行改成跑草稿之后，最容易出的事故是
  // 「调试快照被定时器也捡走了」—— 那等于不点发布就上线了。
  //
  // 定时是唯一绕过 runstore.create_run 直接 INSERT runs 的路径
  // （scheduler.ts 的 enqueue），所以必须单独钉住。
  const broken = { ...DEF(flowId), name: '这一版不该被定时跑到', nodes: [] }
  await pool.query(
    `INSERT INTO flow_versions (flow_id, version, definition, kind)
     VALUES ($1, -1, $2, 'draft') ON CONFLICT DO NOTHING`,
    [flowId, JSON.stringify(broken)],
  )
  // 草稿也一起改坏 —— 调度器读的必须是 active_version 的定义，不是 draft
  await pool.query('UPDATE flows SET draft = $2 WHERE id = $1', [flowId, JSON.stringify(broken)])

  const due = new Date('2026-03-02T01:00:00Z')
  await syncSchedule(flowId, '0 9 * * *', 'Asia/Shanghai', new Date('2026-03-01T00:00:00Z'))
  await pool.query('UPDATE schedules SET next_fire_at = $2 WHERE flow_id = $1', [flowId, due])
  await runSchedulerTick(new Date(due.getTime() + 1000))

  const { rows } = await pool.query(
    `SELECT flow_version FROM runs WHERE flow_id = $1 AND trigger_kind = 'schedule'
      ORDER BY created_at DESC LIMIT 1`,
    [flowId],
  )
  assert.equal(rows[0].flow_version, 1, '★★ 定时钉的是 active_version，绝不碰任何调试快照')
})

test('★★ syncAllSchedules 只读已发布那一版的 trigger', { skip: SKIP }, async () => {
  // 「改了 cron 但没发布」不该改变实际调度时刻 —— 否则草稿一存，
  // 线上的触发时间就跟着变了，而用户根本没点发布
  await syncSchedule(flowId, '0 9 * * *', 'Asia/Shanghai', new Date('2026-03-01T00:00:00Z'))
  const before = (await nextFire()).next_fire_at

  const rescheduled = { ...DEF(flowId), trigger: { kind: 'schedule' as const, mode: 'daily', at: '23:30' } }
  await pool.query(
    `INSERT INTO flow_versions (flow_id, version, definition, kind)
     VALUES ($1, -2, $2, 'draft') ON CONFLICT DO NOTHING`,
    [flowId, JSON.stringify(rescheduled)],
  )
  await pool.query('UPDATE flows SET draft = $2 WHERE id = $1', [flowId, JSON.stringify(rescheduled)])

  const sched = await import('../worker/scheduler.ts')
  await sched.syncAllSchedules()

  const { rows } = await pool.query('SELECT cron, next_fire_at FROM schedules WHERE flow_id = $1', [flowId])
  assert.equal(rows[0].cron, '0 9 * * *', '★★ 草稿里的新 cron 没有发布，不许生效')
  assert.equal(rows[0].next_fire_at.getTime(), before.getTime(), '触发时刻纹丝不动')
})
