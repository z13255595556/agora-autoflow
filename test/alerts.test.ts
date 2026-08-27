import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'

/**
 * 失败告警取地址那一步。**需要真的 Postgres。**
 *
 *   DATABASE_URL=postgresql://workflow:workflow@127.0.0.1:5432/workflow \
 *     node --test --experimental-strip-types test/alerts.test.ts
 *
 * 没设 DATABASE_URL 就跳过并明确说出来 —— 不能让"没跑"看起来像"跑过了"。
 *
 * 这个文件锁的是**合并规则**：流程级覆盖用户级，两个都没有就不登记。
 * 值得单独锁住，因为它错了的症状是**告警静默不发** —— 而"告警没发"这件事
 * 本身不会以任何形式表现出来（worker/alerts.ts 开头那段说的就是它）。
 *
 * 只测 recordRunAlert（登记）。deliverPending（投递）会真的往企微发 HTTP，
 * 不在这里跑。
 */

const DSN = process.env.DATABASE_URL ?? ''
const SKIP = !DSN

if (SKIP) {
  test('跳过：没有 DATABASE_URL，告警测试需要真的 Postgres', () => {})
}

let pool: import('pg').Pool
let recordRunAlert: (runId: string) => Promise<void>

const HOOK_FLOW = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=flow-level-key'
const HOOK_USER = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=user-level-key'

const OWNER = `alerts_test_${Math.random().toString(36).slice(2, 8)}@example.com`

/** run_status 枚举里失败叫 **error**（steps 那张表的失败才叫 failed）。
 *  两边不同名，写混了会被 Postgres 直接拒掉 —— 这里取个常量免得再踩 */
const RUN_FAILED = 'error'
const made: { flows: string[]; runs: string[] } = { flows: [], runs: [] }

before(async () => {
  if (SKIP) return
  const alerts = await import('../worker/alerts.ts')
  const store = await import('../worker/store.ts')
  recordRunAlert = alerts.recordRunAlert
  pool = store.pool
})

after(async () => {
  if (SKIP) return
  if (made.runs.length) await pool.query('DELETE FROM alerts WHERE run_id = ANY($1)', [made.runs])
  if (made.runs.length) await pool.query('DELETE FROM steps WHERE run_id = ANY($1)', [made.runs])
  if (made.runs.length) await pool.query('DELETE FROM runs WHERE id = ANY($1)', [made.runs])
  if (made.flows.length) await pool.query('DELETE FROM flow_versions WHERE flow_id = ANY($1)', [made.flows])
  if (made.flows.length) await pool.query('DELETE FROM flows WHERE id = ANY($1)', [made.flows])
  await pool.query('DELETE FROM user_notify_settings WHERE email = $1', [OWNER])
  await pool.end()
})

/** 建一条流程。owner 传 null 就是「无主」（008 迁移之前建的那种） */
async function mkFlow(opts: { owner: string | null; flowHook?: string }): Promise<string> {
  const id = `alert_${Math.random().toString(36).slice(2, 10)}`
  made.flows.push(id)
  const def = { id, version: 1, name: `告警测试 ${id}`, inputs: { type: 'object', properties: {} },
                trigger: { kind: 'manual' }, nodes: [], edges: [], layout: {} }
  await pool.query(
    'INSERT INTO flows (id, name, draft, active_version, owner, notify_config) VALUES ($1,$2,$3,1,$4,$5)',
    [id, def.name, JSON.stringify(def), opts.owner,
     opts.flowHook ? JSON.stringify({ webhook: opts.flowHook }) : null],
  )
  // runs 的外键是 (flow_id, flow_version) → flow_versions，版本行必须先在
  await pool.query('INSERT INTO flow_versions (flow_id, version, definition) VALUES ($1,1,$2)',
                   [id, JSON.stringify(def)])
  return id
}

/** 建一条**已经进终态**的 run，外加一个失败的步骤，直接喂给 recordRunAlert */
async function mkRun(flowId: string, status: string, opts: { failedNode?: string; error?: string } = {}) {
  const id = `run_${Math.random().toString(36).slice(2, 10)}`
  made.runs.push(id)
  await pool.query(
    "INSERT INTO runs (id, flow_id, flow_version, trigger_input, status, error, trigger_kind)"
    + " VALUES ($1,$2,1,'{}',$3,$4,'manual')",
    [id, flowId, status, opts.error ?? null],
  )
  if (opts.failedNode) {
    await pool.query(
      "INSERT INTO steps (run_id, seq, node_id, status, error) VALUES ($1,1,$2,'failed',$3)",
      [id, opts.failedNode, opts.error ?? '失败了'],
    )
  }
  return id
}

async function alertOf(runId: string) {
  const { rows } = await pool.query('SELECT payload, dedup_key FROM alerts WHERE run_id = $1', [runId])
  return rows[0] ?? null
}

const setUserHook = (hook: string | null) =>
  hook
    ? pool.query(
        'INSERT INTO user_notify_settings (email, webhook) VALUES ($1,$2)'
        + ' ON CONFLICT (email) DO UPDATE SET webhook = EXCLUDED.webhook', [OWNER, hook])
    : pool.query('DELETE FROM user_notify_settings WHERE email = $1', [OWNER])

// ---------------------------------------------------------------- 合并规则

test('只配了用户级 → 用用户级地址', { skip: SKIP }, async () => {
  await setUserHook(HOOK_USER)
  const flowId = await mkFlow({ owner: OWNER })
  const runId = await mkRun(flowId, RUN_FAILED, { failedNode: 'n2', error: '表不存在' })

  await recordRunAlert(runId)

  const a = await alertOf(runId)
  assert.ok(a, '应该登记了一条告警')
  assert.equal(a.payload.webhook, HOOK_USER)
  assert.equal(a.payload.failedNode, 'n2')
  assert.equal(a.payload.reason, '表不存在')
})

test('★ 两个都配了 → 流程级覆盖用户级', { skip: SKIP }, async () => {
  await setUserHook(HOOK_USER)
  const flowId = await mkFlow({ owner: OWNER, flowHook: HOOK_FLOW })
  const runId = await mkRun(flowId, RUN_FAILED, { failedNode: 'n1', error: '超时' })

  await recordRunAlert(runId)

  const a = await alertOf(runId)
  assert.ok(a)
  assert.equal(a.payload.webhook, HOOK_FLOW, '这条流程单独配了，就该发到它那个群')
})

test('两个都没配 → 不登记（别堆一堆发不出去的）', { skip: SKIP }, async () => {
  await setUserHook(null)
  const flowId = await mkFlow({ owner: OWNER })
  const runId = await mkRun(flowId, RUN_FAILED, { failedNode: 'n1', error: '啥也没配' })

  await recordRunAlert(runId)

  assert.equal(await alertOf(runId), null)
})

test('★ 无主流程 → 没有"通知谁"这个答案，不登记', { skip: SKIP }, async () => {
  // owner 为 NULL 时 LEFT JOIN 落空。这里刻意让用户级**是**配着的：
  // 证明不发的原因是"这条流程不归他"，而不是"没人配过"
  await setUserHook(HOOK_USER)
  const flowId = await mkFlow({ owner: null })
  const runId = await mkRun(flowId, RUN_FAILED, { failedNode: 'n1', error: '无主' })

  await recordRunAlert(runId)

  assert.equal(await alertOf(runId), null)
})

test('别人的流程失败，不会用我的地址发', { skip: SKIP }, async () => {
  await setUserHook(HOOK_USER)
  const flowId = await mkFlow({ owner: 'someone.else@example.com' })
  const runId = await mkRun(flowId, RUN_FAILED, { failedNode: 'n1', error: '不是我的' })

  await recordRunAlert(runId)

  assert.equal(await alertOf(runId), null)
})

// ---------------------------------------------------------------- 什么时候不该告警

test('成功的运行不告警', { skip: SKIP }, async () => {
  await setUserHook(HOOK_USER)
  const flowId = await mkFlow({ owner: OWNER })
  const runId = await mkRun(flowId, 'success')

  await recordRunAlert(runId)

  assert.equal(await alertOf(runId), null)
})

test('主动取消的运行不告警 —— 那是人干的，不是故障', { skip: SKIP }, async () => {
  await setUserHook(HOOK_USER)
  const flowId = await mkFlow({ owner: OWNER })
  const runId = await mkRun(flowId, 'canceled')

  await recordRunAlert(runId)

  assert.equal(await alertOf(runId), null)
})

// ---------------------------------------------------------------- 抑制

test('★ 两条不同流程共用一个用户级地址时互不抑制', { skip: SKIP }, async () => {
  // 用户级之后多条流程会发进同一个群，dedup_key 要是不带 flow_id，
  // 第二条流程失败就会被第一条压掉 —— 而且是静默的
  await setUserHook(HOOK_USER)
  const a = await mkFlow({ owner: OWNER })
  const b = await mkFlow({ owner: OWNER })
  const runA = await mkRun(a, RUN_FAILED, { failedNode: 'n1', error: '同一个原因' })
  const runB = await mkRun(b, RUN_FAILED, { failedNode: 'n1', error: '同一个原因' })

  await recordRunAlert(runA)
  await recordRunAlert(runB)

  const alertA = await alertOf(runA)
  const alertB = await alertOf(runB)
  assert.ok(alertA && alertB, '两条都该登记')
  assert.notEqual(alertA.dedup_key, alertB.dedup_key, 'dedup_key 必须带 flow_id 才分得开')
})
