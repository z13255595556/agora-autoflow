import type { FlowRun, JsonSchema } from '../types'

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
export const FILTERS = [
  'count', 'json', 'list', 'lines', 'table', 'date',
  'at', 'first', 'last', 'find', 'column',
  // 聚合。日报里天天要写"总数是多少""去重后几个""排前三的是谁"，
  // 以前只能回去改 SQL —— 而改 SQL 意味着多跑一次几分钟的 Hive 查询
  'sum', 'unique', 'join', 'sort',
  // 缺值逃生口。引用取不到值时引擎会报错（而不是像以前那样渲染成空串），
  // 确实允许缺值的场合用它显式声明：{{ $.x | default('—') }}
  'default',
] as const

/**
 * 按**顶层**竖线切开表达式：`rows | sort(dc, desc) | at(0, name)`
 * → `['rows', 'sort(dc, desc)', 'at(0, name)']`
 *
 * 引号里的竖线不是管道 —— `join('|')` 的分隔符就是一根竖线，切错了就把
 * 用户的参数劈成两段。
 *
 * 住在 output.ts 而不是 engine.ts：校验方 vars.ts 要用它逐个查过滤器名，
 * 而 engine.ts 又要用 vars.ts 的 validateNode，放 engine 就成了循环依赖。
 * 这和 FILTERS 当初搬过来是同一个理由。
 */
export function splitTopLevelPipes(expr: string): string[] {
  const out: string[] = []
  let cur = ''
  let quote: string | null = null
  for (const c of expr) {
    if (quote) {
      cur += c
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") {
      quote = c
      cur += c
    } else if (c === '|') {
      out.push(cur.trim())
      cur = ''
    } else {
      cur += c
    }
  }
  out.push(cur.trim())
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)

/**
 * 某个节点"现在"的输出：固定数据优先，否则取最近一次运行的最后一步。
 *
 * 这三行原先在 NodeDetailView、MessagePreview 各抄了一遍。pin 优先的规则来自
 * NDV 的「pinned 数据是输出栏的当前真相」，**每一处都必须一致** —— 不然界面上
 * 看到的表格和表达式解析出来的会是两份数据。
 *
 * 住在这里而不是 engine.ts：它讲的是"哪份输出算当前的"，属于输出形态那一族；
 * 而 outputShape.ts 也要用它，从 engine 取会绕出一条
 * vars → outputShape → engine → vars 的环。engine 那边再导出一次给老调用点。
 */
export function latestOutput(run: FlowRun | null, pinData: Record<string, unknown>, nodeId: string): unknown {
  if (Object.prototype.hasOwnProperty.call(pinData, nodeId)) return pinData[nodeId]
  return run?.steps[nodeId]?.at(-1)?.output
}

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

const jsonType = (value: unknown): JsonSchema['type'] => {
  if (Array.isArray(value)) return 'array'
  if (isRecord(value)) return 'object'
  if (typeof value === 'boolean') return 'boolean'
  if (typeof value === 'number') return Number.isInteger(value) ? 'integer' : 'number'
  return 'string'
}

/**
 * 从 HTTP 响应体学习可直接引用的对象字段。只保存路径与类型，不保存响应值。
 * 点路径无法表达的 key（含点、空格等）不生成变量，避免选择后运行失败。
 *
 * 对象数组要下钻成 `items[].name` 这种形状：和 SQL 的 `rows[].col` 同一个约定，
 * probedContainer / probedColumns 的 `indexOf('[].')` 直接解得开，pushFirstRowVars
 * 随即产出 `body.items[0].name`。不下钻的话「HTTP 返回一个列表」这种最常见的
 * 形状在变量里只是一个光秃秃的 `body.items`，什么都选不出来。
 */
export function toResponseFields(output: unknown): Record<string, JsonSchema> | null {
  if (!isRecord(output) || output.body === undefined) return null
  const fields: Record<string, JsonSchema> = {}
  let count = 0
  const walk = (value: Record<string, unknown>, prefix: string, depth: number) => {
    if (depth > 3 || count >= 80) return
    for (const [key, child] of Object.entries(value)) {
      if (count >= 80) break
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
      const path = `${prefix}.${key}`
      const type = jsonType(child)
      fields[path] = { type, title: key }
      count += 1
      if (type === 'object' && isRecord(child)) walk(child, path, depth + 1)
      // 对象数组：按首项的形状记列。空数组和标量数组没有列可记，跳过
      else if (type === 'array' && Array.isArray(child) && isRecord(child[0])) {
        walk(child[0], `${path}[]`, depth + 1)
      }
    }
  }
  if (isRecord(output.body)) {
    walk(output.body, 'body', 0)
  } else if (Array.isArray(output.body) && isRecord(output.body[0])) {
    walk(output.body[0], 'body[]', 0)
  } else {
    fields.body = { type: jsonType(output.body), title: '响应体' }
    count += 1
  }
  return count ? fields : null
}

/** HTTP 等对象型动态输出里已学习到的字段；SQL 的 rows[].x 不属于变量路径。 */
export function probedObjectFields(probed: Record<string, JsonSchema> | undefined): Array<{ path: string; schema: JsonSchema }> {
  return Object.entries(probed ?? {})
    .filter(([path]) => !path.includes('[].'))
    .map(([path, schema]) => ({ path, schema }))
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
