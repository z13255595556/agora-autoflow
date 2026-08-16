/**
 * engine-core 的词汇表。**前端、worker、迁移脚本、文档共用这一份。**
 *
 * 分散定义的后果在这个项目里已经有先例：types.ts 里那句注释说的
 * "manifest 全量覆盖 registry，注解一上线就没，而且只在线上没，本地永远测不出来"。
 * 状态词表如果两边各写一份，症状是同一条运行在 UI 上和库里显示成不同状态。
 */

/**
 * 一步的状态。**7 态，不是 11 态。**
 *
 * Airflow 需要 11 个状态是因为它的 scheduler / worker / triggerer 是三个进程，
 * 状态枚举兼职承担了进程间的交接协议（queued 表示"scheduler 交出去了但 worker 还没接"）。
 * 本项目是单机单 worker + 数据库队列，那些交接态没有对应物；而每加一个态，
 * RunPanel、运行列表、SSE 增量、清理任务、告警判定全都要多一个分支，
 * 且 up_for_retry / timeout / crashed / failed 四者在界面上用户根本分不清。
 *
 * 三件事正交开：status（这里）+ failureKind（为什么失败）+ waitKind（在等什么）。
 */
export type StepStatus =
  | 'queued'    // 已决定要跑，还没有执行者认领
  | 'running'   // 执行者持有中
  | 'waiting'   // 没有执行者持有，带一个到期时刻，到点由唤醒循环捡起来
  | 'success'
  | 'failed'
  | 'skipped'
  | 'canceled'

export const TERMINAL_STATUSES: readonly StepStatus[] = ['success', 'failed', 'skipped', 'canceled']

export const isTerminal = (s: StepStatus): boolean => TERMINAL_STATUSES.includes(s)

/**
 * waiting 在等什么。
 *
 * deferred（等平台任务）和 retry backoff（等退避时钟）在调度器眼里是同一件事：
 * 一行没有执行者持有、带一个到期时刻、到点由同一个循环唤醒。做成两个 status，
 * decide()、兜底扫描、UI 色板、SSE 各要多一个分支，而分支里的代码逐字相同。
 */
export type WaitKind =
  | 'poll'    // 异步节点已提交，等平台出结果。progress 里必须有 handle 或 submitKey
  | 'retry'   // 失败后退避，等 nextRetryAt
  | 'fanout'  // 循环节点等各次迭代跑完

/** 失败的分类。只在 status='failed' 时有意义 */
export type FailureKind =
  | 'business'  // 节点自己返回的业务错误（SQL 语法错、必填项没填）—— 不该重试
  | 'infra'     // 网络、网关、凭证 —— 该重试
  | 'timeout'
  | 'canceled'

/**
 * 为什么没跑。
 *
 * 今天三套灭活逻辑产生的 skipped 在界面上长得一模一样，而重构调度逻辑之后
 * 用户能理解的只会更少。更实际的一点：这是替换调度逻辑时**唯一的验证手段** ——
 * 没有它，一个节点该跑没跑只能靠肉眼比对画布。
 */
export type SkipReason =
  | { kind: 'skipped_by'; by: string; port: string }  // 被某个 flow.if 的某个口灭掉
  | { kind: 'upstream_failed'; src: string }
  | { kind: 'unreachable' }                            // 从根节点已经到不了
  | { kind: 'run_failed' }                             // 全局 fail-fast
  | { kind: 'no_incoming' }                            // 非触发器节点没有入边
  | { kind: 'no_iterations' }                          // 循环展开 0 项，体内节点不跑

/**
 * 一步的身份。
 *
 * loopPath 是数组而不是单个 index：嵌套循环放开时一个字段都不用改。
 * 空数组 = 不在任何循环体内。
 */
export interface StepKey {
  nodeId: string
  loopPath: number[]
}

export const stepKeyOf = (k: StepKey): string =>
  k.loopPath.length ? `${k.nodeId}#${k.loopPath.join('.')}` : k.nodeId

// ---------------------------------------------------------------- 常量
//
// 全仓各只有一个出处（含 SQL、文档、Python）。scripts/check-constants.sh 是门禁。

/**
 * 单个 foreach 的迭代上限。
 *
 * 超限是**整个节点失败**而不是截断 —— 截断会让"少跑了几百条"变成一次绿色的运行。
 * 对齐 Airflow 的 max_map_length 默认值。
 *
 * **不要把它复制成 SQL 的 CHECK 约束**：改它要写迁移，而且用户拿到的会是一个
 * CHECK 违例异常，而不是今天那句能照做的话（"请在上游 SQL 里加 LIMIT"）。
 */
export const MAX_LOOP_ITERATIONS = 1000

/**
 * 节点输出超过这个大小就转存外部存储，事件里只留引用。
 *
 * 256 KB 的理由：一次典型 SQL 结果（1000 行 × 10 列）序列化后 100-300 KB。
 * 64 KB 会把**常见情况**也推去外部存储，为最普通的路径加一层间接；
 * 4 MB 会让 run_events 和 SSE 推送迅速变胖，而单条运行的价值不随体积增长。
 *
 * 这个数曾经在三份文档里写成三个不同的值（4MB / 64KB / 256KB）——
 * 正是它一直没能落地的原因。
 */
export const OUTPUT_INLINE_LIMIT_BYTES = 256 * 1024
