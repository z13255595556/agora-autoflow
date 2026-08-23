import type { NodeRetryOverride, RetryPolicy } from '../../types.ts'

/**
 * 错误码与重试判定。**必须和 server/sql_service/errors.py 逐字对齐。**
 *
 * 这个项目里已经有一条同样的约定（registry.ts ↔ manifest.py），理由也一样：
 * 不一致的后果只在线上出现，本地永远测不出来。所以两边各有一份常量表，
 * 外加一条对齐测试。
 *
 * 在此之前，引擎判断能不能重试靠**匹配中文串**：
 * `if (msg.includes('已不在数据平台上')) throw err`
 * —— 改一个字文案就静默失效，而失效的表现是"本该重试的没重试"
 * 或者更糟的"不该重试的一直重试"，两者都不报错。
 */

export const RETRYABLE: Readonly<Record<string, boolean>> = {
  // 业务错：调用方改 SQL / 改参数才能解决
  SQL_PARAM_ERROR: false,
  SQL_QUERY_ERROR: false,
  SQL_NOT_READONLY: false,
  RESULT_EXPIRED: false,
  BAD_REQUEST: false,
  WECOM_ERROR: false,
  HTTP_TARGET_BLOCKED: false,
  // 基础设施：等一会儿可能就好了
  PLATFORM_AUTH: true,
  PLATFORM_UNAVAILABLE: true,
  SERVICE_UNAVAILABLE: true,
  UPSTREAM_TIMEOUT: true,
  RATE_LIMITED: true,
}

/**
 * 认不出的错误码**当作不可重试**。
 *
 * 这个方向是有意的：把不该重试的重试了，代价是平台上多跑几个大查询、
 * 群里多发几条消息；把该重试的漏了，代价只是一次失败。前者更贵。
 */
export function isRetryable(code: string | null | undefined): boolean {
  return RETRYABLE[code ?? ''] ?? false
}

/** failed 的分类。business 不重试，infra 才重试 */
export function failureKindOf(code: string | null | undefined, httpStatus?: number): 'business' | 'infra' | 'timeout' {
  if (code === 'UPSTREAM_TIMEOUT') return 'timeout'
  if (isRetryable(code)) return 'infra'
  // 没有错误码时退回按 HTTP 状态判：4xx（除 429）是调用方的问题
  if (code == null && httpStatus !== undefined) {
    if (httpStatus === 429 || httpStatus >= 500) return 'infra'
  }
  return 'business'
}

/**
 * 连续轮询失败到这个次数才认输。
 *
 * **轮询失败 ≠ 查询失败**：网络抖一下、节点服务重启一下，平台上那个 job 还
 * 好好地跑着，判死它既丢了结果又让集群继续白烧到自己结束。
 *
 * 定在这里而不是各引擎里各写一个：浏览器里的 engine 和服务端的 worker 跑的是
 * 同一条流程，"平台抖一下算不算失败"两边给出不同答案是没法解释的 ——
 * 而且这种不一致只在线上出现。
 */
export const MAX_CONSECUTIVE_POLL_FAILURES = 5

/**
 * 重试的第 n 次该等多久（n 从 1 起）。
 *
 * 四要素来自 Temporal 的 RetryPolicy：
 * `min(initialMs × backoffCoefficient^(n-1), maximumIntervalMs)`
 *
 * 形状就是 types.ts 的 RetryPolicy —— 这里曾经另有一份写死的 DEFAULT_RETRY 表，
 * 和 manifest 里声明的数字对不上（sql.query 一边 2 次一边 3 次），而 manifest
 * 那份没人读。现在策略只从节点类型的 policy.retry 来，见 resolveRetry。
 */
export type RetrySpec = RetryPolicy

/**
 * 一个节点实例最终按什么重试。
 *
 * - 类型没声明 policy.retry → null（不重试）。http.request 是有意不声明的：
 *   它在节点内自己重试（网络错 / 429 / 5xx，500ms 级），再叠一层 worker 重试
 *   就是 3 × (1 + maxRetries) 次请求，对非幂等的 POST 尤其危险
 * - 实例 retry === null → 用户明确关掉
 * - 实例 retry 给了次数 / 首次间隔 → 覆盖；系数和上限仍按类型
 *
 * 次数夹在 1..10，间隔夹在 0..maximumIntervalMs —— 导入的 JSON 能写任何数字
 */
/**
 * 把 manifest 里的 policy.retry 补成四要素。
 *
 * 老版本的服务端（还没重启、或者还没升级）下发的是 `{maxAttempts, backoff, initialMs}`
 * 三要素 —— 直接用会算出 NaN 秒。前端和 worker 都不该因为后端晚升级一天而坏掉
 */
export function normalizeRetryPolicy(raw: unknown): RetryPolicy | null {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Partial<RetryPolicy> & { backoff?: string }
  const maxAttempts = Number(p.maxAttempts)
  const initialMs = Number(p.initialMs)
  if (!Number.isFinite(maxAttempts) || !Number.isFinite(initialMs)) return null
  const coefficient = Number(p.backoffCoefficient)
  const maximum = Number(p.maximumIntervalMs)
  return {
    maxAttempts,
    initialMs,
    backoffCoefficient: Number.isFinite(coefficient) && coefficient > 0 ? coefficient : p.backoff === 'fixed' ? 1 : 2,
    maximumIntervalMs: Number.isFinite(maximum) && maximum > 0 ? maximum : 60_000,
  }
}

export function resolveRetry(
  policy: RetryPolicy | undefined,
  override: NodeRetryOverride | undefined,
): RetrySpec | null {
  const base = normalizeRetryPolicy(policy)
  if (!base) return null
  if (override === null) return null
  const maxAttempts = override?.maxAttempts ?? base.maxAttempts
  const initialMs = override?.initialMs ?? base.initialMs
  return {
    maxAttempts: Math.min(10, Math.max(1, Math.round(Number(maxAttempts) || 1))),
    initialMs: Math.min(base.maximumIntervalMs, Math.max(0, Math.round(Number(initialMs) || 0))),
    backoffCoefficient: base.backoffCoefficient,
    maximumIntervalMs: base.maximumIntervalMs,
  }
}

export function backoffMs(spec: RetrySpec, attempt: number): number {
  return Math.min(spec.initialMs * spec.backoffCoefficient ** Math.max(0, attempt - 1), spec.maximumIntervalMs)
}
