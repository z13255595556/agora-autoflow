import pg from 'pg'
import type { DecideStep } from '../src/lib/engine-core/decide.ts'
import { stepKeyOf } from '../src/lib/engine-core/types.ts'

/**
 * worker 的数据库层。**worker 和 api 之间不直接通信，只通过 Postgres。**
 *
 * 这样 worker 可以随时重启、可以起多个、崩了也不会让 api 跟着挂。
 * 队列也是 Postgres 做的（FOR UPDATE SKIP LOCKED）—— 不引 Redis：
 * 个位数并发下它只是多一个要运维的组件。
 */

const connectionString = process.env.DATABASE_URL?.trim()

export const pool = new pg.Pool({
  // 没有 URL 时 node-postgres 自动读取 PGHOST/PGPORT/PGDATABASE/PGUSER/PGPASSWORD。
  ...(connectionString ? { connectionString } : {}),
  max: 4,
})

export interface RunRow {
  id: string
  flow_id: string
  flow_version: number
  status: 'queued' | 'running' | 'canceling' | 'success' | 'error' | 'canceled'
  mode: string
  trigger_input: Record<string, unknown>
  scheduled_time: Date
  cancel_requested_at: Date | null
  attempt: number
  /** 谁持有租约。worker 每轮都要比对它 —— 被抢走就必须立刻停手，
   *  否则两个 worker 会同时推进同一条 run */
  lease_owner: string | null
}

export interface StepRow extends DecideStep {
  output: unknown
  input: unknown
  error: string | null
  progress: Record<string, unknown>
  seq: number
}

/** 一次租约多久。心跳按它的三分之一续 */
export const LEASE_SECONDS = 60

/**
 * 认领一条待跑的 run。
 *
 * FOR UPDATE SKIP LOCKED：多个 worker 同时扫同一张表时各取各的，不互相阻塞。
 * 这就是「Postgres 当队列」的全部机制 —— 够用，且少一个组件。
 */
export async function claimRun(workerId: string, onlyFlowId?: string): Promise<RunRow | null> {
  // onlyFlowId 只给测试用：多个测试文件并行跑时都从同一个队列认领，
  // 谁抢到对方的 run 谁就把对方弄红。生产上不传，认领全部
  const { rows } = await pool.query<RunRow>(
    `UPDATE runs SET
       status = 'running',
       lease_owner = $1,
       lease_expires = now() + ($2 || ' seconds')::interval,
       started_at = COALESCE(started_at, now()),
       attempt = attempt + 1
     WHERE id = (
       SELECT id FROM runs
       WHERE status = 'queued' AND ($3::text IS NULL OR flow_id = $3)
       ORDER BY created_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1
     )
     RETURNING *`,
    [workerId, LEASE_SECONDS, onlyFlowId ?? null],
  )
  return rows[0] ?? null
}

/** 续租。返回 false 表示租约已经被别人抢走了 —— 此时必须立刻停手 */
export async function heartbeat(runId: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE runs SET lease_expires = now() + ($3 || ' seconds')::interval
     WHERE id = $1 AND lease_owner = $2 AND status IN ('running','canceling')`,
    [runId, workerId, LEASE_SECONDS],
  )
  return (rowCount ?? 0) > 0
}

/**
 * 回收失联 worker 的 run。
 *
 * 没有它的话 worker 崩了，run 永远停在 running：界面显示"运行中"，
 * 实际没有任何进程在推进它 —— 和今天"关掉标签页"的后果一模一样，只是更隐蔽。
 */
export async function reapExpired(maxAttempts = 3): Promise<number> {
  const { rowCount } = await pool.query(
    `UPDATE runs SET status = 'queued', lease_owner = NULL, lease_expires = NULL
     WHERE status IN ('running','canceling') AND lease_expires < now() AND attempt < $1`,
    [maxAttempts],
  )
  const dead = await pool.query(
    `UPDATE runs SET status = 'error', finished_at = now(),
       error = 'worker 反复失联，已放弃（attempt >= ' || attempt || '）'
     WHERE status IN ('running','canceling') AND lease_expires < now() AND attempt >= $1`,
    [maxAttempts],
  )
  return (rowCount ?? 0) + (dead.rowCount ?? 0)
}

export async function loadFlowVersion(flowId: string, version: number): Promise<Record<string, unknown>> {
  const { rows } = await pool.query<{ definition: Record<string, unknown> }>(
    'SELECT definition FROM flow_versions WHERE flow_id = $1 AND version = $2',
    [flowId, version],
  )
  if (!rows[0]) throw new Error(`流程 ${flowId} 没有第 ${version} 版`)
  return rows[0].definition
}

/**
 * 这一版是谁发布的。**定时和 webhook 触发就以这个人的名义去数据平台查数。**
 *
 * 后台运行没有登录用户 —— 浏览器根本不在场，读不到任何 cookie。发布者是唯一
 * 说得通的人选：他按下发布，就是他让这条流程每天自己跑起来的。
 *
 * 读的是**运行钉住的那一版**（runs.flow_version）而不是当前 owner：改天流程
 * 转手了，历史那一次运行当时用谁的权限跑的，记录里还得能对得上。
 */
export async function publisherOf(flowId: string, version: number): Promise<string | null> {
  const { rows } = await pool.query<{ created_by: string | null }>(
    'SELECT created_by FROM flow_versions WHERE flow_id = $1 AND version = $2',
    [flowId, version],
  )
  return rows[0]?.created_by ?? null
}

export async function loadSteps(runId: string): Promise<StepRow[]> {
  const { rows } = await pool.query(
    `SELECT node_id, loop_path, status, matched, fanout, output, input, error, progress, seq
     FROM steps WHERE run_id = $1 ORDER BY seq`,
    [runId],
  )
  return rows.map((r) => ({
    nodeId: r.node_id,
    loopPath: r.loop_path,
    status: r.status,
    ...(r.matched === null ? {} : { matched: r.matched }),
    ...(r.fanout === null ? {} : { fanout: r.fanout }),
    output: r.output,
    input: r.input,
    error: r.error,
    progress: r.progress ?? {},
    seq: Number(r.seq),
  }))
}

export interface StepWrite {
  nodeId: string
  loopPath: number[]
  status: DecideStep['status']
  input?: unknown
  output?: unknown
  error?: string
  failureKind?: string
  waitKind?: string
  matched?: boolean
  fanout?: number
  progress?: Record<string, unknown>
  nextWakeAt?: Date
  skipReason?: unknown
}

/**
 * 写一步。**这就是「节点边界即存档点」。**
 *
 * 每个节点跑完写一行库。节点数是个位数到几十、单个 sql.query 动辄几分钟，
 * 一行库的开销可以忽略；换来的是 worker 从任何一步之后重启都能接着算。
 *
 * ON CONFLICT 更新而不是插入新行：同一个 (node, loopPath) 的 running → success
 * 是同一行的状态推进。重试的次数记在 attempt 列上，不另起一行。
 */
export async function writeStep(runId: string, w: StepWrite): Promise<void> {
  await pool.query(
    `INSERT INTO steps (run_id, node_id, loop_path, status, input, output, error,
                        failure_kind, wait_kind, matched, fanout, progress, next_wake_at,
                        skip_reason, seq, started_at, finished_at, heartbeat_at)
     VALUES ($1,$2,$3,$4::step_status,$5::jsonb,$6::jsonb,$7,$8,$9,$10,$11,
             COALESCE($12::jsonb,'{}'::jsonb),$13::timestamptz,$14::jsonb,
             (SELECT COALESCE(MAX(seq),0)+1 FROM steps WHERE run_id = $1),
             now(),
             -- $4 显式转 text 再比：同一个占位符既要当 step_status 列的值、
             -- 又要参与字符串比较，不转型 Postgres 推不出一致类型
             CASE WHEN $4::text IN ('success','failed','skipped','canceled') THEN now() END,
             now())
     ON CONFLICT (run_id, node_id, loop_path) DO UPDATE SET
       status = EXCLUDED.status,
       input = COALESCE(EXCLUDED.input, steps.input),
       output = COALESCE(EXCLUDED.output, steps.output),
       error = EXCLUDED.error,
       failure_kind = EXCLUDED.failure_kind,
       wait_kind = EXCLUDED.wait_kind,
       matched = COALESCE(EXCLUDED.matched, steps.matched),
       fanout = COALESCE(EXCLUDED.fanout, steps.fanout),
       -- progress 合并而不是覆盖：submit_key 先落，handle 后到，
       -- 后一次写不能把前一次的痕迹抹掉
       progress = steps.progress || EXCLUDED.progress,
       next_wake_at = EXCLUDED.next_wake_at,
       skip_reason = COALESCE(EXCLUDED.skip_reason, steps.skip_reason),
       finished_at = CASE WHEN EXCLUDED.status IN ('success','failed','skipped','canceled')
                          THEN now() ELSE steps.finished_at END,
       heartbeat_at = now()`,
    [
      runId, w.nodeId, w.loopPath, w.status,
      w.input === undefined ? null : JSON.stringify(w.input),
      w.output === undefined ? null : JSON.stringify(w.output),
      w.error ?? null, w.failureKind ?? null, w.waitKind ?? null,
      w.matched ?? null, w.fanout ?? null,
      w.progress ? JSON.stringify(w.progress) : null,
      w.nextWakeAt ?? null,
      w.skipReason ? JSON.stringify(w.skipReason) : null,
    ],
  )
}

/** append-only 事件。SSE 增量推送和事后回放都读它 */
export async function appendEvent(
  runId: string,
  type: string,
  payload: Record<string, unknown> = {},
  nodeId?: string,
  loopPath?: number[],
): Promise<void> {
  await pool.query(
    `INSERT INTO run_events (run_id, seq, type, node_id, loop_path, payload)
     VALUES ($1, (SELECT COALESCE(MAX(seq),0)+1 FROM run_events WHERE run_id=$1), $2,$3,$4,$5)`,
    [runId, type, nodeId ?? null, loopPath ?? null, JSON.stringify(payload)],
  )
}

export async function finishRun(runId: string, status: 'success' | 'error' | 'canceled', error?: string): Promise<void> {
  await pool.query(
    `UPDATE runs SET status = $2, finished_at = now(), error = $3,
       lease_owner = NULL, lease_expires = NULL
     WHERE id = $1`,
    [runId, status, error ?? null],
  )
  await appendEvent(runId, 'run.finished', { status, ...(error ? { error } : {}) })
}

/**
 * 运行日志保留几天。**默认 14 天** —— steps 里装的是每个节点的输入输出
 * （查询结果本身），既是排查依据也是敏感数据：留短了"上周那次为什么发错"
 * 查不了，留长了等于永久囤着别人的查询结果，还让控制库单调膨胀。
 */
export const RUN_RETENTION_DAYS = Math.max(1, Number(process.env.RUN_RETENTION_DAYS ?? 14) || 14)

/**
 * 清掉超过保留期的运行日志。返回删了几条 run。
 *
 * 只删**终态**的 run（success/error/canceled），按 finished_at 计龄 ——
 * 排队里或在跑的即使很老也不碰：那是 reaper 的职责，清理器越权收尸
 * 会把"卡住待查"的现场直接销毁。steps 和 run_events 挂着 ON DELETE
 * CASCADE，删 runs 一条就全干净，不需要也不允许分表各删（分开删会出现
 * "run 还在、步骤没了"的半截现场）。
 *
 * 幂等且并发安全：多个 worker 同时跑最多互相白扫一遍，不需要锁。
 */
export async function purgeExpiredRuns(days: number = RUN_RETENTION_DAYS): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM runs
     WHERE status IN ('success','error','canceled')
       AND finished_at < now() - ($1 || ' days')::interval`,
    [days],
  )
  return rowCount ?? 0
}

/**
 * 清掉没有任何运行记录引用的调试快照（负数版本）。返回删了几行。
 *
 * **必须在 purgeExpiredRuns 之后跑** —— runs 对 flow_versions 有外键，
 * 先把过期的运行记录收掉，才轮得到它们引用的快照。
 *
 * 只删负数的。**正数版本一行都不删** —— 那是线上跑过什么的历史，
 * 和运行日志不是一类东西，没有保留期。这条不对称是有意的。
 *
 * 年龄阈值和运行日志保留期一致，而服务端复用快照的窗口
 * （flowstore.DRAFT_SNAPSHOT_REUSE_DAYS）明显更短：这道差值是留给
 * "服务端正准备复用某份快照"的安全边界。
 */
export async function purgeOrphanDraftVersions(days: number = RUN_RETENTION_DAYS): Promise<number> {
  const { rowCount } = await pool.query(
    `DELETE FROM flow_versions fv
      WHERE fv.version < 0
        AND fv.created_at < now() - ($1 || ' days')::interval
        AND NOT EXISTS (
          SELECT 1 FROM runs r
           WHERE r.flow_id = fv.flow_id AND r.flow_version = fv.version)`,
    [days],
  )
  return rowCount ?? 0
}

export const keyOf = stepKeyOf
