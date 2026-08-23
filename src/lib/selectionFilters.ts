export type FilterResult = { handled: boolean; value?: unknown }

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const decodeSingleQuoted = (body: string): string => {
  let out = ''
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index]
    if (char !== '\\' || index === body.length - 1) {
      out += char
      continue
    }
    const escaped = body[index + 1]
    index += 1
    if (escaped === 'b') out += '\b'
    else if (escaped === 'f') out += '\f'
    else if (escaped === 'n') out += '\n'
    else if (escaped === 'r') out += '\r'
    else if (escaped === 't') out += '\t'
    else if (escaped === "'") out += "'"
    else if (escaped === '\\') out += '\\'
    else if (escaped === 'u' && /^[0-9a-fA-F]{4}$/.test(body.slice(index + 1, index + 5))) {
      out += String.fromCharCode(Number.parseInt(body.slice(index + 1, index + 5), 16))
      index += 4
    } else out += `\\${escaped}`
  }
  return out
}

/**
 * find / where 共用的比较。两边都能走 `String()` 比较是刻意的：SQL 查回来的
 * vid 可能是数字，用户在面板里填的永远是字符串，`123 == '123'` 必须成立。
 */
export const MATCH_OPERATORS = ['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte'] as const
export type MatchOperatorName = (typeof MATCH_OPERATORS)[number]

export function matchesOperator(actual: unknown, operator: unknown, expected: unknown): boolean {
  switch (String(operator)) {
    case 'eq': return actual === expected || String(actual) === String(expected)
    case 'neq': return !(actual === expected || String(actual) === String(expected))
    case 'contains': return String(actual ?? '').includes(String(expected ?? ''))
    case 'gt': return Number(actual) > Number(expected)
    case 'gte': return Number(actual) >= Number(expected)
    case 'lt': return Number(actual) < Number(expected)
    case 'lte': return Number(actual) <= Number(expected)
    default: throw new Error(`不支持的匹配方式 ${String(operator)}，可用：${MATCH_OPERATORS.join(' / ')}`)
  }
}

/** 新可视化选择器使用的纯数据过滤器。无 eval、无属性表达式执行。 */
export function applySelectionFilter(value: unknown, name: string, args: unknown[]): FilterResult {
  if (!['at', 'first', 'last', 'column', 'find', 'where', 'limit'].includes(name)) return { handled: false }
  const rows = Array.isArray(value) ? value : []
  const selected = (row: unknown, column: unknown) => {
    if (column === undefined || column === '') return row
    return isRecord(row) ? row[String(column)] : undefined
  }

  switch (name) {
    case 'at': {
      const index = Number(args[0])
      return { handled: true, value: Number.isInteger(index) && index >= 0 ? selected(rows[index], args[1]) : undefined }
    }
    case 'first': return { handled: true, value: selected(rows[0], args[0]) }
    case 'last': return { handled: true, value: selected(rows.at(-1), args[0]) }
    case 'column': {
      const key = String(args[0] ?? '')
      return { handled: true, value: key ? rows.map((row) => isRecord(row) ? row[key] : undefined) : [] }
    }
    case 'find': {
      const [matchColumn, operator = 'eq', expected, resultColumn] = args
      const row = rows.find((item) => matchesOperator(isRecord(item) ? item[String(matchColumn)] : undefined, operator, expected))
      return { handled: true, value: selected(row, resultColumn) }
    }
    case 'where': {
      // 和 find 同一套比较，但保留**全部**匹配行。"只发 dc>5 的"以前只能回去改 SQL
      const [matchColumn, operator = 'eq', expected] = args
      return {
        handled: true,
        value: rows.filter((item) => matchesOperator(isRecord(item) ? item[String(matchColumn)] : undefined, operator, expected)),
      }
    }
    case 'limit': {
      // 前 n 行。配合 sort 就是"前十名"；以前要为此拖一个「列表处理」节点
      const n = Number(args[0])
      if (!Number.isInteger(n) || n < 0) throw new Error(`|limit 需要一个非负整数，例如 |limit(10)，实际是 ${String(args[0])}`)
      return { handled: true, value: rows.slice(0, n) }
    }
    default: return { handled: false }
  }
}

/** 支持引号内逗号和基础 JSON 字面量的过滤器参数解析。 */
export function parseFilterArgs(source: string): unknown[] {
  const out: unknown[] = []
  let token = ''
  let quote: '"' | "'" | null = null
  let escaped = false
  const push = () => {
    const raw = token.trim()
    token = ''
    if (!raw) return
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      const body = raw.slice(1, -1)
      out.push(raw[0] === '"' ? JSON.parse(raw) : decodeSingleQuoted(body))
    } else if (/^-?\d+(?:\.\d+)?$/.test(raw)) out.push(Number(raw))
    else if (raw === 'true') out.push(true)
    else if (raw === 'false') out.push(false)
    else if (raw === 'null') out.push(null)
    else out.push(raw)
  }
  for (const char of source) {
    if (escaped) { token += char; escaped = false; continue }
    if (char === '\\' && quote) { token += char; escaped = true; continue }
    if (quote) { token += char; if (char === quote) quote = null; continue }
    if (char === '"' || char === "'") { quote = char; token += char; continue }
    if (char === ',') { push(); continue }
    token += char
  }
  if (quote) throw new Error('过滤器参数的引号没有闭合')
  push()
  return out
}
