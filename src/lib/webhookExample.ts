import type { FlowInputField } from '../types'
import { coerceInput } from './runRequest.ts'

/**
 * 生成给上游的调用示例。
 *
 * 单独一个模块而不是塞在组件里：这里每一个字符都会被复制粘贴到别的系统里去，
 * 拼错一个头名字，对方调试半天才发现是我们给的示例不对 —— 这种东西要能测。
 */

export type AuthMode = 'secret' | 'hmac' | 'none'

/** 占位密钥。真密钥只在创建那一刻有，之后面板上只能给这个 */
export const SECRET_PLACEHOLDER = '你的密钥'

/** 完整触发地址。origin 来自 client.webhookOrigin() */
export function webhookUrl(origin: string, token: string): string {
  return `${origin.replace(/\/+$/, '')}/hooks/${token}`
}

/**
 * 按流程入参造一个示例 body。
 *
 * **只出现声明过的入参** —— 服务端也是这么筛的（body 里多余的顶层字段直接丢），
 * 示例里凭空多一个字段会让人以为它会被传进去。
 */
export function sampleBody(inputs: FlowInputField[]): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const f of inputs) {
    if (!f.key) continue
    out[f.key] = f.default !== undefined && f.default !== ''
      ? coerceInput(f, f.default)
      : f.type === 'integer' ? 123
        : f.type === 'number' ? 1.5
          : f.type === 'boolean' ? true
            : f.type === 'date' ? '2026-08-21'
              : f.type === 'select' ? (f.options?.[0] ?? '选项')
                : `示例${f.title || f.key}`
  }
  return out
}

/** body 里没有任何入参时，POST 一个空对象也是合法的 */
export function sampleBodyJson(inputs: FlowInputField[]): string {
  return JSON.stringify(sampleBody(inputs))
}

export interface CurlOptions {
  url: string
  authMode: AuthMode
  /** 明文密钥；拿不到时传 undefined，示例里用占位符 */
  secret?: string | null
  inputs: FlowInputField[]
}

/**
 * 一段可以直接粘进终端跑的 curl。
 *
 * hmac 那一档要多绕一步：服务端算签名用的 key 是**密钥的 sha256 十六进制**
 * （与服务端认证 hash 对齐），不是密钥本身。这件事没人猜得到，
 * 所以示例里必须把这一步显式写出来。
 */
export function curlExample({ url, authMode, secret, inputs }: CurlOptions): string {
  const body = sampleBodyJson(inputs)
  const key = secret || SECRET_PLACEHOLDER

  if (authMode === 'none') {
    return [
      `curl -X POST '${url}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -d '${body}'`,
    ].join('\n')
  }

  if (authMode === 'secret') {
    return [
      `curl -X POST '${url}' \\`,
      `  -H 'Content-Type: application/json' \\`,
      `  -H 'X-Webhook-Secret: ${key}' \\`,
      `  -d '${body}'`,
    ].join('\n')
  }

  // hmac：签名对的是 `{时间戳}.{原始 body}`，且 body 必须原样发出去 ——
  // 重新序列化一遍（key 顺序、空格）签名就对不上了
  return [
    `SECRET='${key}'`,
    `BODY='${body}'`,
    `# 签名密钥 = 密钥的 sha256，不是密钥本身`,
    `KEY=$(printf %s "$SECRET" | shasum -a 256 | cut -d' ' -f1)`,
    `TS=$(date +%s)`,
    `SIG=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "$KEY" | awk '{print $NF}')`,
    `curl -X POST '${url}' \\`,
    `  -H 'Content-Type: application/json' \\`,
    `  -H "X-Timestamp: $TS" \\`,
    `  -H "X-Signature: sha256=$SIG" \\`,
    `  -d "$BODY"`,
  ].join('\n')
}

/** 面板上「节点参数」和「已生效配置」之间的差异。空数组 = 一致 */
export function settingsDrift(
  node: {
    authMode?: unknown
    rateLimitPerMin?: unknown
    responseMode?: unknown
    responseTimeoutSeconds?: unknown
  },
  live: {
    authMode: string
    rateLimitPerMin: number
    responseMode: string
    responseTimeoutSeconds: number
  },
): string[] {
  const drift: string[] = []
  const auth = node.authMode
  if (typeof auth === 'string' && auth && auth !== live.authMode) {
    drift.push(`认证方式 ${live.authMode} → ${auth}`)
  }
  const rate = node.rateLimitPerMin
  if (typeof rate === 'number' && Number.isInteger(rate) && rate !== live.rateLimitPerMin) {
    drift.push(`每分钟上限 ${live.rateLimitPerMin} → ${rate}`)
  }
  const response = node.responseMode
  if (typeof response === 'string' && response && response !== live.responseMode) {
    drift.push(`响应方式 ${responseLabel(live.responseMode)} → ${responseLabel(response)}`)
  }
  const timeout = node.responseTimeoutSeconds
  if (typeof timeout === 'number' && Number.isInteger(timeout) && timeout !== live.responseTimeoutSeconds) {
    drift.push(`同步等待 ${live.responseTimeoutSeconds} 秒 → ${timeout} 秒`)
  }
  return drift
}

function responseLabel(mode: string): string {
  return mode === 'lastNode' ? '等待结果' : mode === 'immediate' ? '立即响应' : mode
}
