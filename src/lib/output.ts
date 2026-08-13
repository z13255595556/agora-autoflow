import type { JsonSchema } from '../types'

/**
 * 节点输出里"那一批数据"惯用的容器字段名。
 *
 * 这串字面量原先散在 engine.itemCount、NodeDetailView.OutputTable 里各写一遍，
 * 加一种节点就得记得三处都改。收在这里。
 */
export const ROW_KEYS = ['rows', 'hits', 'series', 'results', 'branches'] as const

/**
 * 可用的格式化过滤器。
 *
 * 放这里而不是 engine.ts：校验方 vars.ts 要用，而 engine.ts 又要用 vars.ts
 * 的 validateNode —— 放 engine 就成了循环依赖。output.ts 谁都不依赖。
 */
export const FILTERS = ['count', 'json', 'list', 'lines', 'table', 'date'] as const

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 从输出里认出可以按表格渲染的那一批行。
 *
 * 只认"非空且首项是对象"的数组 —— 空数组和标量数组渲染成表格没有意义，
 * 交给调用方走 JSON 分支。顶层就是数组时 key 为空串。
 */
export function extractRows(output: unknown): { key: string; rows: Record<string, unknown>[] } | null {
  if (Array.isArray(output)) {
    return output.length && isRecord(output[0]) ? { key: '', rows: output as Record<string, unknown>[] } : null
  }
  if (!isRecord(output)) return null
  for (const key of ROW_KEYS) {
    const v = output[key]
    if (Array.isArray(v) && v.length && isRecord(v[0])) {
      return { key, rows: v as Record<string, unknown>[] }
    }
  }
  return null
}

export interface LearnedColumns {
  /** 行所在的容器字段名，例如 sql.query 的 'rows' */
  container: string
  columns: Array<{ name: string; type?: string }>
}

/**
 * 从一次真实运行的输出里学出列名。
 *
 * 优先用后端声明的 columns（sql.query 每次 poll 都返回，带真实字段类型），
 * 拿不到才退化成对行取 key 并集 —— 并集会漏掉"恰好这几行为 null"的列，
 * 所以只当兜底。
 *
 * 容器判定不要求数组非空：查询命中 0 行时 rows 是空数组，但 columns 声明
 * 还在，这种情况照样应该学到列名。
 */
export function learnColumns(output: unknown): LearnedColumns | null {
  if (!isRecord(output)) return null
  const container = ROW_KEYS.find((k) => Array.isArray(output[k]))
  if (!container) return null

  const declared = output.columns
  if (Array.isArray(declared)) {
    const cols = declared
      .filter(isRecord)
      .map((c) => ({ name: String(c.name ?? ''), type: c.type === undefined ? undefined : String(c.type) }))
      .filter((c) => c.name)
    if (cols.length) return { container, columns: cols }
  }

  const rows = output[container] as unknown[]
  const names = [...new Set(rows.flatMap((r) => (isRecord(r) ? Object.keys(r) : [])))]
  return names.length ? { container, columns: names.map((name) => ({ name })) } : null
}

/**
 * 转成 node.data.probedOutput 的存储形状。
 *
 * key 保持 `rows[].列名`：mockOutput 按这个前缀反解列名造假数据。注意这个
 * 形状**不是**可用的变量路径 —— lookupPath 解不了 `rows[].x`，所以它不该
 * 出现在 availableVars 里（那正是之前静默渲染成空字符串的原因）。
 */
export function toProbedFields(learned: LearnedColumns): Record<string, JsonSchema> {
  const out: Record<string, JsonSchema> = {}
  for (const c of learned.columns) {
    out[`${learned.container}[].${c.name}`] = { type: 'string', title: c.name, description: c.type }
  }
  return out
}

/** 从 probedOutput 反解出列名，供选列器和预览用 */
export function probedColumns(probed: Record<string, JsonSchema> | undefined): Array<{ name: string; type?: string }> {
  const out: Array<{ name: string; type?: string }> = []
  for (const [key, sub] of Object.entries(probed ?? {})) {
    const i = key.indexOf('[].')
    const name = i < 0 ? '' : key.slice(i + 3)
    if (name) out.push({ name, type: sub.description })
  }
  return out
}

/** probedOutput 里行容器的字段名（`rows[].x` → `rows`）。学不到就按 rows 兜底。 */
export function probedContainer(probed: Record<string, JsonSchema> | undefined): string {
  for (const key of Object.keys(probed ?? {})) {
    const i = key.indexOf('[].')
    if (i > 0) return key.slice(0, i)
  }
  return 'rows'
}
