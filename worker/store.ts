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

/**
 * 交给唤醒循环。**异步节点提交之后走这条路,不是直接 return。**
 *
 * driveRun 遇到"没有节点可跑、但有 waiting 的行"时会返回,把 worker 让出来 ——
 * 一条五分钟的 Hive 查询不该把 worker 占住。但**返回不等于交接**:
 * 光 return 的话 runs 那一行还是 running、租约还是 60 秒后到期,而心跳已经
 * 随 driveRun 一起停了。于是 60 秒后 reapExpired 看到"running + 租约过期",
 * 判定 worker 失联,重排;再认领、再返回、再 60 秒 —— 三次之后这条 run 被
 * 判死,错误写的是"worker 反复失联"。
 *
 * **实际后果:任何异步查询只要跑过 3 分钟就必然失败**,和 SQL 本身无关。
 * 而且判死之后 wakeDeferred 的 `r.status IN ('running','queued')` 不再匹配,
 * 轮询停止 —— 数据平台上那个查询没人管了,handle 就这么漏掉。
 *
 * 所以这里把租约续到一个**远期**时刻再放手:
 * - reaper 扫的是租约过期的行,续了就不会误伤
 * - claimRun 只找 queued,status 仍是 running 就不会被反复认领
 *   （置回 queued 的话每秒会被认领一次,attempt 一路涨,run.started 刷满事件表）
 * - wakeDeferred 在**真有进展时**（轮询完成 / 退避到期）负责把它置回 queued
 * - 唤醒循环自己坏掉的话,远期租约到期后 reaper 照原样兜底 —— 不会永久卡住
 */
export const DEFERRED_LEASE_SECONDS = Number(process.env.WORKER_DEFERRED_LEASE_SECONDS ?? 3600)

export async function deferRun(runId: string, workerId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    `UPDATE runs SET lease_owner = NULL,
       lease_expires = now() + ($3 || ' seconds')::interval
     WHERE id = $1 AND lease_owner = $2 AND status = 'running'`,
    [runId, workerId, DEFERRED_LEASE_SECONDS],
  )
  return (rowCount ?? 0) > 0
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

/**
 * 按哪个时区切「一天」。日报是按人看的，UTC 切出来的天会让早上八点前的运行
 * 算到前一天去 —— 统计对不上直觉就没人信。
 */
export const USAGE_TIMEZONE = process.env.USAGE_TIMEZONE?.trim() || 'Asia/Shanghai'

/**
 * 重算最近几天的用量并写进 usage_daily。
 *
 * **必须明显小于保留期**（默认 14 天，这里取 12）。一旦某一天的运行开始被
 * purgeExpiredRuns 清掉，再去重算那一天就会把完整的统计覆盖成残缺的 ——
 * 而那是不可逆的：明细已经没了，正确的数再也算不回来。
 */
export const USAGE_ROLLUP_DAYS = Math.max(1, RUN_RETENTION_DAYS - 2)

/**
 * 把最近若干天的运行汇总进 usage_daily。返回写了几行。
 *
 * 整天重算 + upsert，所以是幂等的：跑十遍和跑一遍结果一样，中途崩了下一轮补上。
 * 超出窗口的那些天不参与重算，它们的行就此定格 —— 这正是「明细 14 天、
 * 统计永久」成立的方式。
 */
export async function rollUpUsage(days: number = USAGE_ROLLUP_DAYS): Promise<number> {
  const { rowCount } = await pool.query(
    `INSERT INTO usage_daily (day, flow_id, trigger_kind, flow_name, owner,
                              runs, succeeded, failed, canceled,
                              duration_ms, timed_runs, steps, rolled_at)
     SELECT (r.created_at AT TIME ZONE $2)::date,
            r.flow_id, r.trigger_kind,
            COALESCE(f.name, r.flow_id), f.owner,
            count(*),
            count(*) FILTER (WHERE r.status = 'success'),
            count(*) FILTER (WHERE r.status = 'error'),
            count(*) FILTER (WHERE r.status = 'canceled'),
            COALESCE(sum(EXTRACT(EPOCH FROM (r.finished_at - r.started_at)) * 1000)
                       FILTER (WHERE r.started_at IS NOT NULL AND r.finished_at IS NOT NULL), 0)::bigint,
            count(*) FILTER (WHERE r.started_at IS NOT NULL AND r.finished_at IS NOT NULL),
            COALESCE(sum(st.n), 0)::int,
            now()
       FROM runs r
       LEFT JOIN flows f ON f.id = r.flow_id
       LEFT JOIN LATERAL (SELECT count(*) AS n FROM steps s WHERE s.run_id = r.id) st ON true
      WHERE r.created_at >= (now() AT TIME ZONE $2)::date - ($1::int - 1)
      GROUP BY 1, 2, 3, f.name, f.owner
     ON CONFLICT (day, flow_id, trigger_kind) DO UPDATE SET
       flow_name = EXCLUDED.flow_name,
       owner = EXCLUDED.owner,
       runs = EXCLUDED.runs,
       succeeded = EXCLUDED.succeeded,
       failed = EXCLUDED.failed,
       canceled = EXCLUDED.canceled,
       duration_ms = EXCLUDED.duration_ms,
       timed_runs = EXCLUDED.timed_runs,
       steps = EXCLUDED.steps,
       rolled_at = now()
     -- 兜底：重算出来比已存的少，说明明细已经被清掉一部分了，这一次不算数。
     -- 没有这道闸，一次窗口配错就会把历史统计静默抹平
     WHERE EXCLUDED.runs >= usage_daily.runs`,
    [days, USAGE_TIMEZONE],
  )
  return rowCount ?? 0
}

export const keyOf = stepKeyOf
