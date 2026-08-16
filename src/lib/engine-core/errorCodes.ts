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
 * 重试的第 n 次该等多久（n 从 1 起）。
 *
 * 四要素来自 Temporal 的 RetryPolicy：
 * `min(initialMs × backoffCoefficient^(n-1), maximumIntervalMs)`
 */
export interface RetrySpec {
  maxAttempts: number
  initialMs: number
  backoffCoefficient: number
  maximumIntervalMs: number
}

export const DEFAULT_RETRY: Readonly<Record<string, RetrySpec>> = {
  'sql.query': { maxAttempts: 3, initialMs: 5000, backoffCoefficient: 2, maximumIntervalMs: 60_000 },
  'notify.wecom': { maxAttempts: 5, initialMs: 2000, backoffCoefficient: 2, maximumIntervalMs: 10_000 },
  'http.request': { maxAttempts: 3, initialMs: 2000, backoffCoefficient: 2, maximumIntervalMs: 30_000 },
}

export function backoffMs(spec: RetrySpec, attempt: number): number {
  return Math.min(spec.initialMs * spec.backoffCoefficient ** Math.max(0, attempt - 1), spec.maximumIntervalMs)
}
