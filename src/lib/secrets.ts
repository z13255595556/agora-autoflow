const EXACT_SENSITIVE_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'x-auth-token',
])

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase()
  // signature 是为自家 webhook 收上来的 x-signature 加的：签名 + 原始 body 就能
  // 重放那次请求，等同凭证。这条规则在服务端有一份镜像
  // （sql_service/webhooks.py 的 redact_headers），改这里必须同步那边
  return EXACT_SENSITIVE_HEADERS.has(normalized) || /(?:token|secret|api[-_]?key|signature)/i.test(normalized)
}

/**
 * 输出侧脱敏 —— redactNodeInput 的对称件。
 *
 * 入参那半边一直有，出参这半边一直没有：HTTP 响应里的 set-cookie / authorization
 * 至今是明文进运行记录、明文显示在输出面板。取值面板要把真实值摆到用户眼前，
 * 这个洞会从"要点开 JSON 视图才看得到"变成"一眼就在那儿"。
 *
 * **只脱敏展示和预览，不动引用解析出来的真值** —— 运行时该发什么还发什么。
 *
 * 刻意**不**按字段名匹配数据列。`/token|secret/i` 会把 SQL 结果里的 token 列
 * 打码，而那正是这个功能的头号例子（「从查询结果里取第一行的 token」）。
 * 按来源脱敏：响应头、以及从 x-ui.secret 输入回显出来的东西。业务数据是用户
 * 自己 SELECT 出来的，不该替他遮。
 */
export function redactOutput(typeId: string, output: unknown): unknown {
  if (typeId !== 'http.request') return output
  if (output === null || typeof output !== 'object' || Array.isArray(output)) return output
  const o = output as Record<string, unknown>
  const headers = o.headers
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return output
  // 只重建 headers 那一个对象，其余按引用共享 —— 响应体可能很大，深拷贝不值
  return {
    ...o,
    headers: Object.fromEntries(
      Object.entries(headers).map(([key, value]) => [key, isSensitiveHeaderName(key) ? '[REDACTED]' : value]),
    ),
  }
}

/** 运行记录用于调试但不应复制出 HTTP 凭证；真实执行入参不经过这里。 */
export function redactNodeInput(typeId: string, input: Record<string, unknown>): Record<string, unknown> {
  if (typeId !== 'http.request') return input
  const headers = input.headers
  return {
    ...input,
    ...(headers && typeof headers === 'object' && !Array.isArray(headers) ? {
      headers: Object.fromEntries(
        Object.entries(headers).map(([key, value]) => [key, isSensitiveHeaderName(key) ? '[REDACTED]' : value]),
      ),
    } : {}),
    ...('bearerToken' in input ? { bearerToken: '[REDACTED]' } : {}),
    ...('basicPassword' in input ? { basicPassword: '[REDACTED]' } : {}),
    ...('authHeaderValue' in input ? { authHeaderValue: '[REDACTED]' } : {}),
  }
}
