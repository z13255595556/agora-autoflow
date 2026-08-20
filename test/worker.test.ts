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
let reapExpired: (maxAttempts?: number) => Promise<number>
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
  reapExpired = store.reapExpired
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

// ─────────────────────────────────── 等外部系统的 run 不能被当成失联的 worker
//
// 异步节点（Hive/Spark 查询）提交之后置 waiting 就把 worker 让出来，一条五分钟
// 的查询不该占住 worker。但"让出来"必须是显式交接：只 return 的话 runs 还是
// running、租约 60 秒后到期、心跳已经停了 —— reaper 会把"正在等结果"误判成
// "worker 失联"，重排三次后判死。**线上真发生过**：所有跑过 3 分钟的定时 SQL
// 全军覆没，错误写的是"worker 反复失联"。

test('★★ 提交给外部系统之后，run 不会被回收器当成失联的 worker', { skip: SKIP }, async () => {
  const runId = await enqueue()
  // 造出"提交完了正在等结果"的现场：t 跑完了，d 挂在轮询上。
  // **不直接调 deferRun** —— 原来的 bug 正是 driveRun 没调它，
  // 单测 deferRun 本身一样会绿
  await pool.query(
    `INSERT INTO steps (run_id, node_id, status, seq) VALUES ($1, 't', 'success', 1)`, [runId])
  await pool.query(
    `INSERT INTO steps (run_id, node_id, status, wait_kind, next_wake_at, seq)
     VALUES ($1, 'd', 'waiting', 'poll', now() + interval '3 seconds', 2)`, [runId])

  await tick(flowId)   // 认领 → decide 发现没活可干 → 交接

  const { rows } = await pool.query(
    `SELECT status, lease_owner, lease_expires > now() + interval '10 minutes' AS 远期
       FROM runs WHERE id = $1`, [runId],
  )
  assert.equal(rows[0].status, 'running', '仍是 running —— 置回 queued 会被每秒认领一次')
  assert.equal(rows[0].lease_owner, null, '★ worker 已经放手了（原来的 bug：它还攥着一个不再续期的租约）')
  assert.equal(rows[0].远期, true, '租约续到远期，reaper 不会误伤')

  // 关键：把时钟推到"三个租约之后"，回收器一次都不许碰它
  await pool.query("UPDATE runs SET created_at = now() - interval '10 minutes' WHERE id = $1", [runId])
  await reapExpired()
  const after = await runRow(runId)
  assert.equal(after.status, 'running', '★★ 三分钟之后它还活着')
  assert.equal(after.error, null)

  // 反证：租约真的过期了（唤醒循环也坏了），reaper 照原样兜底
  await pool.query("UPDATE runs SET lease_expires = now() - interval '1 second' WHERE id = $1", [runId])
  await reapExpired()
  assert.equal((await runRow(runId)).status, 'queued', '真过期了还是要回收 —— 不能永远卡住')

  await pool.query('DELETE FROM steps WHERE run_id = $1', [runId])
  await pool.query('DELETE FROM runs WHERE id = $1', [runId])
})

// ─────────────────────────────────── 异步查询的超时
//
// 超时**在轮询循环里判**，不在提交那一刻等 —— 提交完 worker 就走了。
// 截止时刻在提交时算成绝对时间写进 progress，之后每轮只做一次比较。

test('★★ 查询超过设定时间：撤销平台任务并判失败，而不是无限等下去', { skip: SKIP }, async () => {
  // 生产里 worker 启动时会 loadRegistry() 把后端 manifest 整个装进来，
  // 而 tick() 不会 —— 测试里只导入了 tick，所以这里手动装一份**形状和后端
  // 一致**的 sql.query。前端 src/registry.ts 那份兜底定义故意没有 runtime
  //（离线时这个节点走 mock，连不上 DataLego），不能拿它当依据
  const { applyBackendNodes } = await import('../src/registry.ts')
  applyBackendNodes([{
    type: 'sql.query', typeVersion: '2.0.0', name: 'DataLego SQL',
    category: '数据查询', icon: '▤', description: '',
    input: { type: 'object', properties: {} }, output: { type: 'object', properties: {} },
    runtime: {
      kind: 'http-async', submit: 'POST /nodes/sql.query/submit',
      poll: 'GET /nodes/sql.query/poll', cancel: 'POST /nodes/sql.query/cancel',
      pollIntervalMs: 3000, defaultTimeoutMinutes: 15, maxTimeoutMinutes: 120,
    },
  } as never])

  const toFlow = `wtest_to_${Math.random().toString(36).slice(2, 8)}`
  const def = {
    id: toFlow, version: 1, name: '超时', inputs: { type: 'object', properties: {} },
    trigger: { kind: 'manual' },
    nodes: [
      { id: 't', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' },
      { id: 'q', type: 'sql.query', typeVersion: '2.0.0', name: '查询', params: { engine: 'hive', sql: 'SELECT 1', timeoutMinutes: 15 }, onError: 'fail' },
    ],
    edges: [{ from: 't', to: 'q' }],
    layout: { t: { x: 0, y: 0 }, q: { x: 1, y: 0 } },
  }
  await pool.query('INSERT INTO flows (id, name, draft, active_version) VALUES ($1,$2,$3,1)',
    [toFlow, def.name, JSON.stringify(def)])
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)',
    [toFlow, JSON.stringify(def)])

  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    "INSERT INTO runs (id, flow_id, flow_version, trigger_input, status) VALUES ($1,$2,1,'{}','running')",
    [runId, toFlow])
  await pool.query("INSERT INTO steps (run_id, node_id, status, seq) VALUES ($1,'t','success',1)", [runId])
  // 提交出去了，handle 在手，截止时刻已经过了
  await pool.query(
    `INSERT INTO steps (run_id, node_id, status, wait_kind, progress, next_wake_at, seq)
     VALUES ($1,'q','waiting','poll',$2, now() - interval '1 second', 2)`,
    [runId, JSON.stringify({ handle: 'job_20260820_000001', deadlineAt: new Date(Date.now() - 1000).toISOString(), timeoutMinutes: 15 })])

  // finally：断言挂了也要收拾干净。不然每失败一次就往开发库里留一条
  // wtest_to_* 的垃圾流程，下次跑测试的人得先猜它们是哪来的
  try {
    await tick(toFlow)

    const { rows } = await pool.query(
      'SELECT status, error, failure_kind FROM steps WHERE run_id=$1 AND node_id=$2', [runId, 'q'])
    assert.equal(rows[0].status, 'failed', '★ 超时要判失败，不能一直 waiting')
    assert.match(rows[0].error, /超过 15 分钟/, '错误里要写清是超时、超了多久')
    assert.match(rows[0].error, /超时时间/, '还要说清怎么改 —— 否则用户只知道失败了')
    // infra 会走退避重试，而重试一次同样会超时；能改的是 SQL 或这个设置
    assert.equal(rows[0].failure_kind, 'business')

    // run 要被放回队列，否则它停在 running 等一个永远不会来的唤醒
    const after = await runRow(runId)
    assert.ok(['queued', 'error'].includes(after.status), `run 要能继续推进，实际 ${after.status}`)
  } finally {
    await pool.query('DELETE FROM run_events WHERE run_id=$1', [runId])
    await pool.query('DELETE FROM steps WHERE run_id=$1', [runId])
    await pool.query('DELETE FROM runs WHERE id=$1', [runId])
    await pool.query('DELETE FROM flow_versions WHERE flow_id=$1', [toFlow])
    await pool.query('DELETE FROM flows WHERE id=$1', [toFlow])
  }
})

