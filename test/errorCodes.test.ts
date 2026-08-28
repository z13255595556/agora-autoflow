import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { RETRYABLE, isRetryable, backoffMs, failureKindOf } from '../src/lib/engine-core/errorCodes.ts'

/**
 * 错误码表必须**两边逐字对齐**。
 *
 * registry.ts ↔ manifest.py 已经有同样的约定，理由也一样：不一致的后果
 * 只在线上出现，本地永远测不出来 —— 服务端改了一个 code 名，引擎的重试策略
 * 就静默失效，而失效的表现是"本该重试的没重试"或"不该重试的一直重试"。
 */

const VENV = 'server/.venv/bin/python'

test('★ TS 与 Python 的错误码表逐字一致', { skip: !existsSync(VENV) }, () => {
  const out = execFileSync(VENV, ['-c',
    'import json,sys; sys.path.insert(0,"server"); from sql_service.errors import RETRYABLE; print(json.dumps(RETRYABLE))',
  ], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] })
  assert.deepEqual(JSON.parse(out.trim()), RETRYABLE)
})

test('认不出的错误码当作不可重试', () => {
  // 方向是有意的：把不该重试的重试了，代价是平台上多跑几个大查询、
  // 群里多发几条消息；把该重试的漏了，代价只是一次失败。前者更贵
  assert.equal(isRetryable('NOPE_UNKNOWN'), false)
  assert.equal(isRetryable(undefined), false)
  assert.equal(isRetryable(null), false)
})

test('业务错不重试，基础设施错才重试', () => {
  assert.equal(isRetryable('SQL_QUERY_ERROR'), false, 'SQL 语法错重试一百次也一样')
  assert.equal(isRetryable('RESULT_EXPIRED'), false)
  assert.equal(isRetryable('PLATFORM_AUTH'), true, '票被拒，续票后可能就行')
  assert.equal(isRetryable('SERVICE_UNAVAILABLE'), true)
})

test('代码节点：只有沙箱不可用可重试，用户代码的错重跑也一样', () => {
  assert.equal(isRetryable('CODE_SANDBOX_UNAVAILABLE'), true, '沙箱进程没起来，等一会儿可能就好')
  assert.equal(isRetryable('CODE_SANDBOX_UNCONFIGURED'), false, '503 但要管理员配置，等不好')
  assert.equal(isRetryable('CODE_SYNTAX_ERROR'), false)
  assert.equal(isRetryable('CODE_RUNTIME_ERROR'), false)
  assert.equal(isRetryable('CODE_TIMEOUT'), false, '纯计算重跑还是超时')
})

test('failureKind：没有错误码时按 HTTP 状态兜底', () => {
  assert.equal(failureKindOf('SQL_QUERY_ERROR'), 'business')
  assert.equal(failureKindOf('PLATFORM_AUTH'), 'infra')
  assert.equal(failureKindOf('UPSTREAM_TIMEOUT'), 'timeout')
  assert.equal(failureKindOf('CODE_TIMEOUT'), 'timeout', '不可重试但界面要标超时，不是业务错')
  assert.equal(failureKindOf(null, 500), 'infra')
  assert.equal(failureKindOf(null, 429), 'infra', '429 该退避重试')
  assert.equal(failureKindOf(null, 400), 'business', '4xx 是调用方的问题')
})

test('退避间隔指数增长且有上限', () => {
  const spec = { maxAttempts: 5, initialMs: 1000, backoffCoefficient: 2, maximumIntervalMs: 5000 }
  assert.deepEqual([1, 2, 3, 4, 5].map((n) => backoffMs(spec, n)), [1000, 2000, 4000, 5000, 5000])
})
