import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * worker 的端到端测试。**需要真的 Postgres + 跑着的节点服务。**
 *
 *   DATABASE_URL=postgresql://workflow:workflow@127.0.0.1:5432/workflow \
 *     node --test --experimental-strip-types test/worker.test.ts
 *
 * 没设 DATABASE_URL 就跳过并明确说出来 —— 不能让"没跑"看起来像"跑过了"。
 *
 * 这里证明的是 M1 的核心承诺：
 * 1. 流程在**服务端**跑完，浏览器一行代码都没参与
 * 2. worker 在任何一步之后崩掉，换个 worker 接着算，结果一样
 */

const DSN = process.env.DATABASE_URL ?? ''
const SKIP = !DSN

if (SKIP) {
  test('跳过：没有 DATABASE_URL，worker 端到端测试需要真的 Postgres', () => {})
}

let pool: import('pg').Pool
let tick: (onlyFlowId?: string) => Promise<{ ran: boolean }>
let purgeExpiredRuns: (days?: number) => Promise<number>
let purgeOrphanDraftVersions: (days?: number) => Promise<number>
let rollUpUsage: (days?: number) => Promise<number>
let flowId: string

const DEF = (id: string) => ({
  id,
  version: 1,
  name: 'worker e2e',
  inputs: { type: 'object' as const, properties: {} },
  trigger: { kind: 'manual' as const },
  nodes: [
    { id: 't', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' as const },
    { id: 'd', type: 'date.compute', typeVersion: '1.0.0', name: '昨天', params: { mode: 'yesterday', format: 'compact' }, onError: 'fail' as const },
    { id: 'm', type: 'transform.template', typeVersion: '1.0.0', name: '文本', params: { template: '日期 {{ $.nodes.d.output.value }}' }, onError: 'fail' as const },
  ],
  edges: [{ from: 't', to: 'd' }, { from: 'd', to: 'm' }],
  layout: { t: { x: 0, y: 0 }, d: { x: 1, y: 0 }, m: { x: 2, y: 0 } },
})

before(async () => {
  if (SKIP) return
  const mod = await import('../worker/index.ts')
  const store = await import('../worker/store.ts')
  tick = mod.tick
  pool = store.pool
  purgeExpiredRuns = store.purgeExpiredRuns
  purgeOrphanDraftVersions = store.purgeOrphanDraftVersions
  rollUpUsage = store.rollUpUsage

  flowId = `wtest_${Math.random().toString(36).slice(2, 10)}`
  const def = DEF(flowId)
  await pool.query('INSERT INTO flows (id, name, draft, active_version) VALUES ($1,$2,$3,1)', [
    flowId, def.name, JSON.stringify(def),
  ])
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)', [
    flowId, JSON.stringify(def),
  ])
})

after(async () => {
  if (SKIP) return
  await pool.query('DELETE FROM runs WHERE flow_id = $1', [flowId])
  await pool.query('DELETE FROM flow_versions WHERE flow_id = $1 AND version < 0', [flowId])
  await pool.query('DELETE FROM flows WHERE id = $1', [flowId])
  await pool.end()
})

async function enqueue(): Promise<string> {
  const id = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    "INSERT INTO runs (id, flow_id, flow_version, trigger_input) VALUES ($1,$2,1,'{}')",
    [id, flowId],
  )
  return id
}

/** 只推进本测试自己的流程 —— 测试文件并行跑时不许抢别人的 run */
async function drain(max = 30): Promise<void> {
  for (let i = 0; i < max; i++) {
    const { ran } = await tick(flowId)
    if (!ran) return
  }
}

async function runRow(id: string) {
  const { rows } = await pool.query('SELECT status, error FROM runs WHERE id = $1', [id])
  return rows[0]
}

async function stepRows(id: string) {
  const { rows } = await pool.query(
    'SELECT node_id, status, output, seq FROM steps WHERE run_id = $1 ORDER BY seq', [id],
  )
  return rows
}

test('★ 流程在服务端跑完，浏览器没有参与', { skip: SKIP }, async () => {
  const runId = await enqueue()
  await drain()

  const r = await runRow(runId)
  assert.equal(r.status, 'success', r.error ?? '')

  const steps = await stepRows(runId)
  assert.deepEqual(steps.map((s) => s.node_id), ['t', 'd', 'm'], '按拓扑序跑完三个节点')
  assert.ok(steps.every((s) => s.status === 'success'))
  assert.match(String(steps[2].output.text), /日期 \d{8}/, '模板拿到了上游的输出')
})

test('★★ 崩溃恢复：跑到一半换个 worker 接着算，已跑过的不重跑', { skip: SKIP }, async () => {
  // 一次 tick 会把整条 run 驱动到终态，所以"跑一步再崩"没法用 tick 模拟。
  // 直接构造崩溃后的库状态：第一个节点已成功、run 被 reaper 放回队列 ——
  // 这正是 worker 死在第一步之后、reaper 回收之后的样子
  const runId = await enqueue()
  await pool.query(
    `INSERT INTO steps (run_id, node_id, loop_path, status, output, seq, started_at, finished_at)
     VALUES ($1,'t','{}','success','{"runId":"pre","startedAt":"2026-01-01T00:00:00Z"}',1, now(), now())`,
    [runId],
  )

  await drain()

  const r = await runRow(runId)
  assert.equal(r.status, 'success', r.error ?? '')
  const steps = await stepRows(runId)
  assert.deepEqual(steps.map((s) => s.node_id), ['t', 'd', 'm'], '接着把剩下两步跑完')
  // ★ 已经跑过的那一步不许重跑 —— 重跑一个 notify.wecom 就是群里多一条消息
  assert.equal(steps.length, 3, '每个节点恰好一行')
  assert.equal(steps[0].output.runId, 'pre', '第一步的输出原样保留，没有被重新执行覆盖')
})

test('★ 失联太久的 run 被判失败而不是永远停在 running', { skip: SKIP }, async () => {
  // 没有 reaper 的话：界面显示"运行中"，实际没有任何进程在推进它 ——
  // 和今天"关掉标签页"的后果一样，只是更隐蔽
  const runId = await enqueue()
  await pool.query(
    `UPDATE runs SET status='running', attempt=3, lease_owner='dead-worker',
       lease_expires = now() - interval '1 hour' WHERE id=$1`,
    [runId],
  )
  await tick(flowId)
  const r = await runRow(runId)
  assert.equal(r.status, 'error')
  assert.match(r.error, /失联/)
})

test('★ 租约过期但还有重试机会时，放回队列而不是判死', { skip: SKIP }, async () => {
  const runId = await enqueue()
  await pool.query(
    `UPDATE runs SET status='running', attempt=1, lease_owner='dead-worker',
       lease_expires = now() - interval '1 hour' WHERE id=$1`,
    [runId],
  )
  await drain()
  const r = await runRow(runId)
  assert.equal(r.status, 'success', '回收之后接着跑完，不是直接判死')
})

test('★ 取消：不新起任何节点，run 收尾成 canceled', { skip: SKIP }, async () => {
  const runId = await enqueue()
  // 取消意图在 worker 认领之前就写下 —— decide 第一轮就会看到 canceling
  await pool.query('UPDATE runs SET cancel_requested_at = now() WHERE id = $1', [runId])
  await drain()

  const r = await runRow(runId)
  assert.equal(r.status, 'canceled')
  const steps = await stepRows(runId)
  assert.equal(steps.filter((s) => s.status === 'success').length, 0, '★ 一个节点都不许跑')
})

test('★ 事件流按 seq 递增，可增量拉取', { skip: SKIP }, async () => {
  const runId = await enqueue()
  await drain()
  const { rows } = await pool.query(
    'SELECT seq, type FROM run_events WHERE run_id = $1 ORDER BY seq', [runId],
  )
  assert.ok(rows.length > 0)
  assert.deepEqual(rows.map((r) => r.seq), rows.map((_, i) => i + 1), 'seq 连续无洞')
  assert.equal(rows.at(-1).type, 'run.finished')
})

test('★ 运行日志过了保留期被清掉，未到期和在跑的都不碰', { skip: SKIP }, async () => {
  const oldRun = await enqueue()
  const freshRun = await enqueue()
  await drain()   // 两条都跑到 success，steps 里躺着每个节点的输入输出

  // 把其中一条"拨老"到保留期之外。stuck 那条永远停在 running ——
  // 清理器不许越权收尸，那是 reaper 的职责
  await pool.query("UPDATE runs SET finished_at = now() - interval '15 days' WHERE id = $1", [oldRun])
  const stuckRun = await enqueue()
  await pool.query(
    "UPDATE runs SET status='running', created_at = now() - interval '30 days' WHERE id = $1",
    [stuckRun],
  )

  await purgeExpiredRuns(14)

  assert.equal(await runRow(oldRun), undefined, '过期的 run 被删掉')
  const { rows: orphans } = await pool.query(
    'SELECT 1 FROM steps WHERE run_id = $1 UNION ALL SELECT 1 FROM run_events WHERE run_id = $1', [oldRun],
  )
  assert.equal(orphans.length, 0, '★ steps 和 run_events 跟着级联删，不留半截现场')
  assert.equal((await runRow(freshRun)).status, 'success', '未到期的原样保留')
  assert.ok((await stepRows(freshRun)).length > 0, '未到期的节点输入输出还在')
  assert.equal((await runRow(stuckRun)).status, 'running', '非终态的即使很老也不删')
  await pool.query("UPDATE runs SET status='canceled', finished_at=now() WHERE id=$1", [stuckRun])
})

test('★ 调试快照（负数版本）照常执行，worker 一行不用改', { skip: SKIP }, async () => {
  // 手动运行跑的是草稿，钉成一份负数版本。loadFlowVersion 精确按
  // runs.flow_version 查表，正负号对它没有意义 —— 这条就是在钉这一点
  await pool.query(
    `INSERT INTO flow_versions (flow_id, version, definition, created_by, kind)
     VALUES ($1, -1, $2, 'alice@agora.io', 'draft') ON CONFLICT DO NOTHING`,
    [flowId, JSON.stringify({ ...DEF(flowId), version: -1 })],
  )
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    "INSERT INTO runs (id, flow_id, flow_version, trigger_input) VALUES ($1,$2,-1,'{}')",
    [runId, flowId],
  )
  await drain()

  const r = await runRow(runId)
  assert.equal(r.status, 'success', r.error ?? '')
  assert.deepEqual((await stepRows(runId)).map((s) => s.node_id), ['t', 'd', 'm'])
})

test('★ 清理调试快照：没人引用的删掉，被引用的和正数版本一律不碰', { skip: SKIP }, async () => {
  // -2 有一条已过期的 run 引用它；-3 是无人引用的老快照；-4 是刚建的孤儿
  const defJson = JSON.stringify({ ...DEF(flowId), version: -2 })
  for (const [v, ageDays] of [[-2, 30], [-3, 30], [-4, 0]] as const) {
    await pool.query(
      `INSERT INTO flow_versions (flow_id, version, definition, kind, created_at)
       VALUES ($1, $2, $3, 'draft', now() - ($4 || ' days')::interval)`,
      [flowId, v, defJson, ageDays],
    )
  }
  const kept = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    `INSERT INTO runs (id, flow_id, flow_version, trigger_input, status, finished_at)
     VALUES ($1,$2,-2,'{}','success', now())`,
    [kept, flowId],
  )

  await purgeOrphanDraftVersions(14)

  const { rows } = await pool.query(
    'SELECT version FROM flow_versions WHERE flow_id = $1 ORDER BY version', [flowId],
  )
  const versions = rows.map((r) => r.version)
  assert.ok(!versions.includes(-3), '过期且无人引用的调试快照被清掉')
  assert.ok(versions.includes(-2), '★ 还有运行记录引用它的不许删 —— 否则运行记录再也解释不了自己')
  assert.ok(versions.includes(-4), '年龄没到保留期的不删')
  assert.ok(versions.includes(1), '★ 正数版本一条都不许碰 —— 那是线上历史，没有保留期')

  await pool.query('DELETE FROM runs WHERE id = $1', [kept])
})

test('★ webhook 投递记录不再挡住运行日志清理', { skip: SKIP }, async () => {
  // webhook_deliveries.run_id 原先是 NO ACTION：批量 DELETE FROM runs 撞外键
  // 整次清理失败，而 worker 把异常吞掉只打一行日志 —— 用了 webhook 的部署
  // 保留期从来没生效过
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    `INSERT INTO runs (id, flow_id, flow_version, trigger_input, status, finished_at)
     VALUES ($1,$2,1,'{}','success', now() - interval '30 days')`,
    [runId, flowId],
  )
  const hookId = `wh_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    `INSERT INTO webhooks (id, flow_id, token) VALUES ($1,$2,$3)`,
    [hookId, flowId, `tok_${hookId}`],
  )
  await pool.query(
    `INSERT INTO webhook_deliveries (webhook_id, run_id, status_code, body_bytes, body_digest)
     VALUES ($1,$2,202,0,'d')`,
    [hookId, runId],
  )

  await purgeExpiredRuns(14)

  assert.equal(await runRow(runId), undefined, '★ 过期的 run 真的被删掉了')
  const { rows } = await pool.query(
    'SELECT run_id FROM webhook_deliveries WHERE webhook_id = $1', [hookId],
  )
  assert.equal(rows.length, 1, '投递记录本身留着 —— 「上游说发了但没跑」的争议靠它')
  assert.equal(rows[0].run_id, null, 'run_id 置空而不是级联删掉整条投递记录')

  await pool.query('DELETE FROM webhook_deliveries WHERE webhook_id = $1', [hookId])
  await pool.query('DELETE FROM webhooks WHERE id = $1', [hookId])
})

test('★ 用量汇总：幂等，且不会被残缺的重算覆盖', { skip: SKIP }, async () => {
  const runId = await enqueue()
  await drain()

  const rolled = await rollUpUsage(12)
  assert.ok(rolled > 0, '有运行记录就该汇总出行')

  const read = async () => {
    const { rows } = await pool.query(
      'SELECT sum(runs)::int AS runs, sum(steps)::int AS steps FROM usage_daily WHERE flow_id = $1',
      [flowId],
    )
    return rows[0]
  }
  const first = await read()
  assert.ok(first.runs > 0 && first.steps > 0, '运行数和节点执行数都记下来了')

  // 整天重算 + upsert：跑十遍和跑一遍一样。不幂等的话每小时一轮会让计数翻倍
  await rollUpUsage(12)
  assert.deepEqual(await read(), first, '再汇总一次，数字纹丝不动')

  // ★★ 明细被清掉之后再重算那一天，只会算出更小的数 —— 那一次**必须不生效**。
  //    没有这道闸，一次窗口配错就会把历史统计静默抹平，而且不可逆
  await pool.query('DELETE FROM run_events WHERE run_id = $1', [runId])
  await pool.query('DELETE FROM steps WHERE run_id = $1', [runId])
  await pool.query('DELETE FROM runs WHERE id = $1', [runId])
  await rollUpUsage(12)
  assert.deepEqual(await read(), first, '★★ 明细少了之后重算不许把已有统计改小')

  await pool.query('DELETE FROM usage_daily WHERE flow_id = $1', [flowId])
})
