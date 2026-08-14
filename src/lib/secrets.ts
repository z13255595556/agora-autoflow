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
  return EXACT_SENSITIVE_HEADERS.has(normalized) || /(?:token|secret|api[-_]?key)/i.test(normalized)
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
