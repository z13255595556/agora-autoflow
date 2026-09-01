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

test('★ 暂停的节点在服务端：记一行 skipped{disabled}，下游照跑，run 成功', { skip: SKIP }, async () => {
  // 和浏览器引擎 / decide 的等价性测试钉的是同一条语义，这里再过一遍真库：
  // skip_reason 要真的写进 steps 表、再被 loadSteps 读回来 —— 漏了哪一头，
  // 下游都会被当成 unreachable 灭掉
  const def = DEF(flowId)
  def.nodes = def.nodes.map((n) => (n.id === 'd' ? { ...n, disabled: true } : n))
  // 下游不引用暂停节点的输出（引用了会在校验期报错，那是另一条规则）
  def.nodes = def.nodes.map((n) => (n.id === 'm' ? { ...n, params: { template: '不看日期' } } : n))
  await pool.query(
    `INSERT INTO flow_versions (flow_id, version, definition, created_by, kind)
     VALUES ($1, -9, $2, 'alice@agora.io', 'draft') ON CONFLICT DO NOTHING`,
    [flowId, JSON.stringify({ ...def, version: -9 })],
  )
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    "INSERT INTO runs (id, flow_id, flow_version, trigger_input) VALUES ($1,$2,-9,'{}')",
    [runId, flowId],
  )
  await drain()

  const r = await runRow(runId)
  assert.equal(r.status, 'success', r.error ?? '')
  const { rows } = await pool.query(
    'SELECT node_id, status, skip_reason FROM steps WHERE run_id = $1 ORDER BY seq', [runId],
  )
  const d = rows.find((x) => x.node_id === 'd')
  assert.equal(d?.status, 'skipped')
  assert.equal(d?.skip_reason?.kind, 'disabled')
  assert.equal(rows.find((x) => x.node_id === 'm')?.status, 'success', '暂停节点的下游照跑')
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

// ─────────────────────────────────── 等待节点（flow.wait）
//
// 真等待只存在于服务端这条路：worker 写一行 waiting/sleep + 到点时刻就交回
// 队列，到点由 wakeDeferred 置 success。这里验的是三件从代码上看不出来的事：
// 等待期间 worker 真的放手了、上限在执行层真的夹住了、取消不用等睡醒。

/** 建一条 t → w(flow.wait) → m 的流程，返回 flowId。用完记得删 */
async function makeWaitFlow(
  params: Record<string, unknown>,
  inputs: Record<string, unknown> = {},
): Promise<string> {
  const id = `wtest_wait_${Math.random().toString(36).slice(2, 8)}`
  const def = {
    id, version: 1, name: '等待', inputs: { type: 'object', properties: inputs },
    trigger: { kind: 'manual' },
    nodes: [
      { id: 't', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' },
      { id: 'w', type: 'flow.wait', typeVersion: '1.0.0', name: '等待', params, onError: 'fail' },
      { id: 'm', type: 'transform.template', typeVersion: '1.0.0', name: '文本', params: { template: '睡了 {{ $.nodes.w.output.waitSeconds }} 秒' }, onError: 'fail' },
    ],
    edges: [{ from: 't', to: 'w' }, { from: 'w', to: 'm' }],
    layout: { t: { x: 0, y: 0 }, w: { x: 1, y: 0 }, m: { x: 2, y: 0 } },
  }
  await pool.query('INSERT INTO flows (id, name, draft, active_version) VALUES ($1,$2,$3,1)',
    [id, def.name, JSON.stringify(def)])
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)',
    [id, JSON.stringify(def)])
  return id
}

async function dropWaitFlow(id: string): Promise<void> {
  await pool.query('DELETE FROM run_events WHERE run_id IN (SELECT id FROM runs WHERE flow_id=$1)', [id])
  await pool.query('DELETE FROM steps WHERE run_id IN (SELECT id FROM runs WHERE flow_id=$1)', [id])
  await pool.query('DELETE FROM runs WHERE flow_id=$1', [id])
  await pool.query('DELETE FROM flow_versions WHERE flow_id=$1', [id])
  await pool.query('DELETE FROM flows WHERE id=$1', [id])
}

/** 反复 tick 直到 run 进终态。等待节点会让 drain() 提前退（deferred 后 tick 无事可做） */
async function tickUntilDone(fid: string, runId: string, ms: number): Promise<void> {
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await tick(fid)
    const { rows } = await pool.query('SELECT status FROM runs WHERE id=$1', [runId])
    if (['success', 'error', 'canceled'].includes(rows[0]?.status)) return
    await new Promise((r) => setTimeout(r, 120))
  }
}

test('★★ 等待节点：worker 交出去等，到点被唤醒循环推完，掷过的时长不重掷', { skip: SKIP }, async () => {
  const fid = await makeWaitFlow({ mode: 'random', minSeconds: 1, maxSeconds: 2 })
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query("INSERT INTO runs (id, flow_id, flow_version, trigger_input) VALUES ($1,$2,1,'{}')", [runId, fid])
  try {
    // 第一次 tick：t 跑完、w 落一行 waiting/sleep、run 交回队列
    await tick(fid)
    const { rows: w1 } = await pool.query(
      "SELECT status, wait_kind, progress FROM steps WHERE run_id=$1 AND node_id='w'", [runId])
    assert.equal(w1[0].status, 'waiting')
    assert.equal(w1[0].wait_kind, 'sleep')
    const planned = w1[0].progress.waitSeconds
    assert.ok(planned >= 1 && planned <= 2, `随机时长要落在区间内，实际 ${planned}`)
    const { rows: r1 } = await pool.query('SELECT status, lease_owner FROM runs WHERE id=$1', [runId])
    assert.equal(r1[0].status, 'running')
    assert.equal(r1[0].lease_owner, null, '★ 等待期间 worker 必须放手 —— 攥着租约睡觉等于占死一个 worker')

    await tickUntilDone(fid, runId, 15000)
    const r = await runRow(runId)
    assert.equal(r.status, 'success', r.error ?? '')
    const { rows: w2 } = await pool.query(
      "SELECT output FROM steps WHERE run_id=$1 AND node_id='w'", [runId])
    assert.equal(w2[0].output.waitSeconds, planned, '★ 到点结算只读落库的数，不重掷')
    const { rows: m } = await pool.query(
      "SELECT output FROM steps WHERE run_id=$1 AND node_id='m'", [runId])
    assert.equal(m[0].output.text, `睡了 ${planned} 秒`, '下游能引用等待节点的输出')
  } finally {
    await dropWaitFlow(fid)
  }
})

test('★ 等待上限分两层：字面量越界显式报错，模板值执行层夹到 3600', { skip: SKIP }, async () => {
  // 第一层：定义里直接写 99999（导入的 JSON 绕过表单）—— worker 的 validateNode
  // 显式拒绝，**不静默夹**：「配了 27 小时」被悄悄改成 1 小时的话，运行是绿的，
  // 没人知道自己的配置没生效
  const fidLit = await makeWaitFlow({ mode: 'fixed', seconds: 99999 })
  const runLit = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query("INSERT INTO runs (id, flow_id, flow_version, trigger_input) VALUES ($1,$2,1,'{}')", [runLit, fidLit])
  try {
    await tick(fidLit)
    const { rows } = await pool.query(
      "SELECT status, error FROM steps WHERE run_id=$1 AND node_id='w'", [runLit])
    assert.equal(rows[0].status, 'failed')
    assert.match(rows[0].error, /1 到 3600/, '错误里要写清允许的范围')
  } finally {
    await dropWaitFlow(fidLit)
  }

  // 第二层：模板算出来的值保存期看不见，校验拦不住 —— 执行层按 SQL 超时同款
  // 规则夹到上限，夹完的数落进 progress，运行详情里看得见
  const fidTpl = await makeWaitFlow(
    { mode: 'fixed', seconds: '{{ $.trigger.delay }}' },
    { delay: { type: 'integer', title: '延迟秒数' } },
  )
  const runTpl = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    "INSERT INTO runs (id, flow_id, flow_version, trigger_input) VALUES ($1,$2,1,'{\"delay\":99999}')",
    [runTpl, fidTpl])
  try {
    await tick(fidTpl)
    const { rows } = await pool.query(
      `SELECT status, progress,
              next_wake_at > now() + interval '3500 seconds' AS 远期,
              next_wake_at < now() + interval '3700 seconds' AS 没超上限
         FROM steps WHERE run_id=$1 AND node_id='w'`, [runTpl])
    assert.equal(rows[0].status, 'waiting')
    assert.equal(rows[0].progress.waitSeconds, 3600)
    assert.equal(rows[0].远期, true)
    assert.equal(rows[0].没超上限, true, '夹完的到点时刻要贴着 1 小时，不是 99999 秒')
  } finally {
    await dropWaitFlow(fidTpl)
  }
})

test('★★ 取消不等睡醒：一小时的等待，点停止秒级收尾', { skip: SKIP }, async () => {
  // ★ 故意用「触发器 → 等待」两个节点、**没有下游**的最小形状：取消那一轮
  //   toSkip 恰好为空，只剩 toCancel —— 有下游的流程会因为下游被记 skipped
  //   而碰巧走上 continue 的路，测不出「取消完没有立刻重算、run 挂在取消中
  //   一小时」那个 bug。UI 里第一次复现用的就是这个形状
  const fid = `wtest_wait_${Math.random().toString(36).slice(2, 8)}`
  const def = {
    id: fid, version: 1, name: '等待取消', inputs: { type: 'object', properties: {} },
    trigger: { kind: 'manual' },
    nodes: [
      { id: 't', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' },
      { id: 'w', type: 'flow.wait', typeVersion: '1.0.0', name: '等待', params: { mode: 'fixed', seconds: 3600 }, onError: 'fail' },
    ],
    edges: [{ from: 't', to: 'w' }],
    layout: { t: { x: 0, y: 0 }, w: { x: 1, y: 0 } },
  }
  await pool.query('INSERT INTO flows (id, name, draft, active_version) VALUES ($1,$2,$3,1)',
    [fid, def.name, JSON.stringify(def)])
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)',
    [fid, JSON.stringify(def)])
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query("INSERT INTO runs (id, flow_id, flow_version, trigger_input) VALUES ($1,$2,1,'{}')", [runId, fid])
  try {
    await tick(fid)   // 进入 waiting/sleep，到点在一小时后
    await pool.query('UPDATE runs SET cancel_requested_at = now() WHERE id = $1', [runId])
    await tickUntilDone(fid, runId, 5000)

    const r = await runRow(runId)
    assert.equal(r.status, 'canceled', '★ 不提前唤醒的话，这里要等满一小时 —— 用户看到的是停止按钮坏了')
    const { rows } = await pool.query(
      "SELECT status FROM steps WHERE run_id=$1 AND node_id='w'", [runId])
    assert.equal(rows[0].status, 'canceled', '等待中的行按取消收尾，不是 success 也不是继续 waiting')
  } finally {
    await dropWaitFlow(fid)
  }
})

test('★★ 取消不等查询跑完：等平台结果的 run，点停止秒级收尾', { skip: SKIP }, async () => {
  // trigger → sql.query 的最小形状。构造的是 deferRun 之后的库状态：
  // submit 已发出、handle 在手、run 是 running/无租约人/租约在一小时后 ——
  // claimRun 捡不到它，唯一能把它领回来的是 wakeDeferred。next_wake_at
  // 故意拨到一小时后（真实 pollIntervalMs 是 3 秒）：「取消靠下一次自然醒
  // 兜底」的错觉正是要测掉的东西 —— 自然醒了也只是继续轮询平台，
  // !body.done 分支不把 run 交回队列，decide 根本看不到取消
  const fid = `wtest_poll_${Math.random().toString(36).slice(2, 8)}`
  const def = {
    id: fid, version: 1, name: '慢查询取消', inputs: { type: 'object', properties: {} },
    trigger: { kind: 'manual' },
    nodes: [
      { id: 't', type: 'trigger.manual', typeVersion: '1.0.0', name: '手动', params: {}, onError: 'fail' },
      { id: 'q', type: 'sql.query', typeVersion: '2.0.0', name: '查询', params: { sql: 'SELECT 1' }, onError: 'fail' },
    ],
    edges: [{ from: 't', to: 'q' }],
    layout: { t: { x: 0, y: 0 }, q: { x: 1, y: 0 } },
  }
  await pool.query('INSERT INTO flows (id, name, draft, active_version) VALUES ($1,$2,$3,1)',
    [fid, def.name, JSON.stringify(def)])
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)',
    [fid, JSON.stringify(def)])
  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  await pool.query(
    `INSERT INTO runs (id, flow_id, flow_version, trigger_input, status, started_at, lease_expires)
     VALUES ($1,$2,1,'{}','running', now(), now() + interval '1 hour')`,
    [runId, fid])
  await pool.query(
    `INSERT INTO steps (run_id, node_id, loop_path, status, output, seq, started_at, finished_at)
     VALUES ($1,'t','{}','success','{}',1, now(), now())`,
    [runId])
  await pool.query(
    `INSERT INTO steps (run_id, node_id, loop_path, status, wait_kind, progress, next_wake_at, seq, started_at)
     VALUES ($1,'q','{}','waiting','poll',$2, now() + interval '1 hour', 2, now())`,
    [runId, JSON.stringify({ handle: 'h-test', deadlineAt: new Date(Date.now() + 600_000).toISOString(), submitKey: 'sk' })])
  try {
    // 反向门禁先测：没被取消、也没到自然醒的点，tick 一轮不许动它 ——
    // 钉住唤醒条件放宽之后，「没到点也没被取消」的行不被误唤醒
    await tick(fid)
    assert.equal((await runRow(runId)).status, 'running', '没取消就不唤醒')
    const before = await pool.query("SELECT status FROM steps WHERE run_id=$1 AND node_id='q'", [runId])
    assert.equal(before.rows[0].status, 'waiting')

    await pool.query('UPDATE runs SET cancel_requested_at = now() WHERE id = $1', [runId])
    await tickUntilDone(fid, runId, 5000)

    const r = await runRow(runId)
    assert.equal(r.status, 'canceled',
      '★ 提前唤醒不认 poll 行的话，这里要等查询自己跑完 —— 而停一条慢查询正是停止按钮最主要的用例')
    const { rows } = await pool.query("SELECT status FROM steps WHERE run_id=$1 AND node_id='q'", [runId])
    assert.equal(rows[0].status, 'canceled', '等结果的行按取消收尾，不是 failed（撤销平台任务失败不改这一点）')
    const { rows: evs } = await pool.query('SELECT type FROM run_events WHERE run_id=$1 ORDER BY seq', [runId])
    assert.equal(evs.at(-1)?.type, 'run.finished')
  } finally {
    await dropWaitFlow(fid)
  }
})


// ─────────────────────────────────── webhook 触发器的预写步骤
//
// 原始 body 由 webhooks.py 在收请求那一刻连同 runs 行同一事务写成触发器的
// success 步骤（runstore.create_run 的 trigger_step）。worker 一行没改 ——
// 这里钉的是它赖以成立的两条既有语义：decide 对已终态的行不重跑；
// ctx 从 success 行取 output 喂给下游。

test('★★ 预写的触发器步骤：worker 不重跑不覆盖，下游能引用 body 全量（含嵌套）', { skip: SKIP }, async () => {
  const fid = `wtest_hook_${Math.random().toString(36).slice(2, 8)}`
  const def = {
    id: fid, version: 1, name: 'webhook 预写', inputs: { type: 'object', properties: {} },
    trigger: { kind: 'webhook' },
    nodes: [
      { id: 'hook', type: 'trigger.webhook', typeVersion: '1.0.0', name: 'Webhook', params: { authMode: 'secret' }, onError: 'fail' },
      { id: 'm', type: 'transform.template', typeVersion: '1.0.0', name: '文本', params: { template: '订单 {{ $.nodes.hook.output.body.order.id }}' }, onError: 'fail' },
    ],
    edges: [{ from: 'hook', to: 'm' }],
    layout: { hook: { x: 0, y: 0 }, m: { x: 1, y: 0 } },
  }
  await pool.query('INSERT INTO flows (id, name, draft, active_version) VALUES ($1,$2,$3,1)',
    [fid, def.name, JSON.stringify(def)])
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)',
    [fid, JSON.stringify(def)])

  const runId = `run_${Math.random().toString(36).slice(2, 10)}`
  // trigger_input 故意留空：下游拿到数据只能来自预写的 output.body，
  // 这正是「嵌套 body / 字段名对不上入参」场景的唯一通道
  await pool.query(
    "INSERT INTO runs (id, flow_id, flow_version, trigger_input, trigger_kind, mode) VALUES ($1,$2,1,'{}','webhook','production')",
    [runId, fid])
  const seeded = {
    body: { order: { id: 7, items: [1, 2] } },
    headers: { 'x-webhook-secret': '[REDACTED]', 'content-type': 'application/json' },
    remoteIp: '10.0.0.9',
    receivedAt: '2026-08-30T00:00:00+00:00',
  }
  await pool.query(
    `INSERT INTO steps (run_id, node_id, status, output, seq, started_at, finished_at)
     VALUES ($1,'hook','success',$2,1, now(), now())`,
    [runId, JSON.stringify(seeded)])

  try {
    await tickUntilDone(fid, runId, 10000)
    const r = await runRow(runId)
    assert.equal(r.status, 'success', r.error ?? '')

    const steps = await stepRows(runId)
    assert.deepEqual(steps.map((s) => s.node_id), ['hook', 'm'], '触发器只有预写那一行，worker 没有另起')
    assert.deepEqual(steps[0].output, seeded, '★ 预写的输出原样保留 —— 被 mock 覆盖成 {} 的话，body 就丢了')
    assert.equal(steps[1].output.text, '订单 7', '★ 下游按 $.nodes.hook.output.body.order.id 取到嵌套字段')
  } finally {
    await dropWaitFlow(fid)
  }
})
