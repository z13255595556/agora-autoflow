export interface CurlImportResult {
  method: string
  url: string
  query: Record<string, string>
  headers: Record<string, string>
  authType: 'none' | 'basic'
  basicUsername?: string
  basicPassword?: string
  bodyType: 'none' | 'json' | 'raw' | 'form-urlencoded'
  body?: string
  formBody: Record<string, string>
  verifySsl: boolean
}

function tokenize(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: "'" | '"' | null = null
  let escaping = false
  for (const char of command.trim()) {
    if (escaping) {
      current += char
      escaping = false
    } else if (char === '\\' && quote !== "'") {
      escaping = true
    } else if (quote) {
      if (char === quote) quote = null
      else current += char
    } else if (char === "'" || char === '"') {
      quote = char
    } else if (/\s/.test(char)) {
      if (current) tokens.push(current)
      current = ''
    } else {
      current += char
    }
  }
  if (escaping || quote) throw new Error('cURL 命令的引号或转义符没有闭合')
  if (current) tokens.push(current)
  return tokens
}

function splitPair(value: string, separator: string): [string, string] {
  const at = value.indexOf(separator)
  return at < 0 ? [value, ''] : [value.slice(0, at), value.slice(at + separator.length)]
}

export function parseCurl(command: string): CurlImportResult {
  const tokens = tokenize(command.replace(/\\\r?\n/g, ' '))
  if (tokens[0]?.toLowerCase() !== 'curl') throw new Error('请输入以 curl 开头的命令')

  let method = ''
  let rawUrl = ''
  let body: string | undefined
  let user: string | undefined
  let verifySsl = true
  const headers: Record<string, string> = {}
  const take = (index: number, option: string) => {
    const value = tokens[index + 1]
    if (value === undefined) throw new Error(`${option} 后面缺少值`)
    return value
  }

  for (let i = 1; i < tokens.length; i++) {
    const token = tokens[i]
    const [option, inline] = token.startsWith('--') && token.includes('=') ? splitPair(token, '=') : [token, '']
    if (option === '-X' || option === '--request') {
      method = inline || take(i++, option)
    } else if (option === '--url') {
      rawUrl = inline || take(i++, option)
    } else if (option === '-H' || option === '--header') {
      const line = inline || take(i++, option)
      const [name, value] = splitPair(line, ':')
      if (!name.trim()) throw new Error('请求头名称不能为空')
      headers[name.trim()] = value.trimStart()
    } else if (['-d', '--data', '--data-raw', '--data-binary'].includes(option)) {
      body = inline || take(i++, option)
    } else if (option === '-u' || option === '--user') {
      user = inline || take(i++, option)
    } else if (option === '-k' || option === '--insecure') {
      verifySsl = false
    } else if (!token.startsWith('-') && !rawUrl) {
      rawUrl = token
    }
  }
  if (!rawUrl) throw new Error('cURL 命令里没有 URL')

  let parsed: URL
  try {
    parsed = new URL(rawUrl)
  } catch {
    throw new Error('cURL 中的 URL 无效')
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('只支持 HTTP 和 HTTPS URL')
  const query = Object.fromEntries(parsed.searchParams.entries())
  parsed.search = ''

  const contentType = Object.entries(headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1]?.toLowerCase() ?? ''
  let bodyType: CurlImportResult['bodyType'] = body === undefined ? 'none' : 'raw'
  let formBody: Record<string, string> = {}
  if (body !== undefined && contentType.includes('application/json')) bodyType = 'json'
  if (body !== undefined && contentType.includes('application/x-www-form-urlencoded')) {
    bodyType = 'form-urlencoded'
    formBody = Object.fromEntries(new URLSearchParams(body).entries())
  }

  const [basicUsername, basicPassword] = user === undefined ? [undefined, undefined] : splitPair(user, ':')
  return {
    method: (method || (body === undefined ? 'GET' : 'POST')).toUpperCase(),
    url: parsed.toString(),
    query,
    headers,
    authType: user === undefined ? 'none' : 'basic',
    basicUsername,
    basicPassword,
    bodyType,
    body: bodyType === 'form-urlencoded' ? undefined : body,
    formBody,
    verifySsl,
  }
}
