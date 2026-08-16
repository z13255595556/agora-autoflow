import type { Block } from './blocks'
import { NODE_TYPE_MAP } from '../registry.ts'
import type { JsonSchema } from '../types'
import { datePresets } from './datefn.ts'

/**
 * 把一个 `{{ }}` 块翻译成人话。
 *
 * `$.nodes.n3.output.rows[0].avg_dc` 这串东西里有四件事用户得同时知道才读得懂：
 * 节点 id 是谁、rows 是容器、方括号是下标、avg_dc 是列名。翻成
 * 「SQL查询·avg_dc·第1行」之后一件都不用知道。
 *
 * 放这里而不是 vars.ts：那个文件已经三百多行，而且它管的是"有哪些变量"，
 * 这里管的是"这个变量怎么念"，两件事。
 */

export interface ChipLabel {
  /** 胶囊面上显示的短文本 */
  text: string
  tone: 'ok' | 'warn' | 'bad'
  /** tooltip：**原始表达式打头**，后面接实时值 */
  title: string
}

export interface LabelCtx {
  nodes: Array<{ id: string; label: string; typeId: string; probedOutput?: Record<string, JsonSchema> }>
  flowInputs: Array<{ key: string; title?: string }>
  /**
   * 当前节点够得着的变量路径（availableVars 的结果）。
   *
   * describeBlock 只认路径的**形状**，它不知道自己是在哪个节点里被调用的。
   * 引用了非上游节点、或者引用了一个不存在的字段，只有对着这份清单才查得出来
   * —— 不传就一律当合法，编辑器里会看不出红。
   */
  known?: Set<string>
  /** 解析实时值，通常包一层 resolveTemplate。拿不到就不显示值 */
  resolve?: (raw: string) => unknown
}

/** 前缀命中即可：rows[0].vid 属于已知的 rows */
function pathKnown(path: string, known: Set<string>): boolean {
  return [...known].some((k) => path === k || path.startsWith(`${k}.`) || path.startsWith(`${k}[`))
}

/** 节点名太长会把胶囊撑破，截短 —— tooltip 里有全名 */
const shortName = (s: string, max = 6) => (s.length > max ? `${s.slice(0, max)}…` : s)

const trunc = (s: string, max: number) => (s.length > max ? `${s.slice(0, max)}…` : s)

/** 值的短表示，和 SchemaForm/VarDrawer 里那两份保持一致 */
export function previewText(v: unknown): string {
  if (v === undefined) return '（无）'
  if (Array.isArray(v)) return `[${v.length} 项]`
  if (v !== null && typeof v === 'object') return '{…}'
  const s = String(v)
  return s.length > 40 ? `${s.slice(0, 40)}…` : s
}

/** 去掉尾部的 `| 过滤器`，返回 [路径, 过滤器名, 参数[]] */
function splitPipe(body: string): { head: string; filter?: string; args: string[] } {
  // 引号里的 | 不是管道。findPipe 在 engine 里是私有的，这里只需要这么多
  let quote: string | null = null
  for (let i = 0; i < body.length; i++) {
    const c = body[i]
    if (quote) {
      if (c === quote) quote = null
      continue
    }
    if (c === '"' || c === "'") quote = c
    else if (c === '|') {
      const rest = body.slice(i + 1).trim()
      const m = rest.match(/^([A-Za-z_]+)\s*(?:\(([^)]*)\))?$/)
      return {
        head: body.slice(0, i).trim(),
        filter: m?.[1],
        args: (m?.[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean),
      }
    }
  }
  return { head: body.trim(), args: [] }
}

/** 一条 $. 路径 → 人话。认不出来就返回 null，交给调用方兜底。 */
function describePath(path: string, ctx: LabelCtx): string | null {
  const trig = path.match(/^\$\.trigger\.([A-Za-z0-9_]+)$/)
  if (trig) {
    const f = ctx.flowInputs.find((x) => x.key === trig[1])
    return `入参·${f?.title || trig[1]}`
  }
  if (path === '$.run.id') return '运行·ID'
  if (path === '$.run.startedAt') return '运行·开始时间'
  if (path === '$.loop.index') return '循环·序号'
  if (path === '$.loop.item') return '循环·当前项'
  const loopField = path.match(/^\$\.loop\.item\.(.+)$/)
  if (loopField) return `循环项·${loopField[1]}`

  const node = path.match(/^\$\.nodes\.([^.]+)\.output(?:\.(.*))?$/)
  if (!node) return null
  const [, id, restRaw] = node
  const n = ctx.nodes.find((x) => x.id === id)
  const who = shortName(n?.label ?? id)
  const rest = restRaw ?? ''
  if (!rest) return `${who}·整个输出`

  // rows[0].avg_dc —— 下标是 0 起的，显示成 1 起的「第N行」。
  // 这是唯一一处会误导的翻译（用户想改成第 2 行得写 [1]），所以 tooltip
  // 永远以原始表达式打头。
  const cell = rest.match(/^([A-Za-z0-9_]+)\[(\d+)\]\.(.+)$/)
  if (cell) return `${who}·${cell[3]}·第${Number(cell[2]) + 1}行`

  const row = rest.match(/^([A-Za-z0-9_]+)\[(\d+)\]$/)
  if (row) return `${who}·第${Number(row[2]) + 1}行`

  // 静态 schema 里声明过的字段，用它的中文 title
  const t = n && NODE_TYPE_MAP.get(n.typeId)
  const title = t?.output.properties?.[rest]?.title
  return `${who}·${title ?? rest}`
}

const FILTER_LABEL: Record<string, (args: string[]) => string> = {
  count: () => '行数',
  json: () => 'JSON',
  table: (a) => (a.length ? `表格 ${a.length}列` : '整张表格'),
  list: (a) => (a.length ? `列表 ${a.length}列` : '整份列表'),
  lines: (a) => (a[0] ? `${a[0]} 整列` : '首列整列'),
  date: (a) => `按 ${a[0] ?? 'date'} 格式化`,
  at: (a) => `${a[1] ? `${a[1]}·` : ''}第${Number(a[0] ?? 0) + 1}行`,
  first: (a) => `${a[0] ? `${a[0]}·` : ''}第一行`,
  last: (a) => `${a[0] ? `${a[0]}·` : ''}最后一行`,
  column: (a) => `${a[0] ?? ''}整列`,
  find: (a) => `${a[3] ? `${a[3]}·` : ''}按 ${a[0] ?? '字段'} 查找`,
}

export function describeBlock(b: Block, ctx: LabelCtx): ChipLabel {
  const value = () => {
    if (!ctx.resolve) return ''
    try {
      const v = ctx.resolve(b.raw)
      return v === undefined ? '' : ` → ${previewText(v)}`
    } catch (err) {
      return ` → ✗ ${err instanceof Error ? err.message : String(err)}`
    }
  }
  const withValue = (text: string, tone: ChipLabel['tone'], note = '') => ({
    text,
    tone,
    title: `${b.raw}${note ? `\n${note}` : ''}${value()}`,
  })

  switch (b.kind) {
    case 'ref': {
      const { head, filter, args } = splitPipe(b.body)
      const who = describePath(head, ctx)
      const suffix = filter ? (FILTER_LABEL[filter]?.(args) ?? filter) : null
      if (!who) return withValue(trunc(b.body, 24), 'bad', '认不出这条引用')
      // 形状认得出来，但当前节点够不够得着是另一回事
      const reach = (b.body.match(/\$\.[A-Za-z0-9_.[\]]+/g) ?? [])
      if (ctx.known && !reach.every((r) => pathKnown(r, ctx.known!))) {
        return withValue(who, 'bad', '这个变量当前节点引用不到')
      }
      // 带过滤器时节点名已经在 who 里，只把过滤器接在后面
      return withValue(suffix ? `${who.split('·')[0]}·${suffix}` : who, 'ok')
    }
    case 'fn': {
      const preset = datePresets().find((p) => p.expr.replace(/\s/g, '') === b.body.replace(/\s/g, ''))
      return withValue(preset ? `日期·${preset.label}` : `日期·${trunc(b.body, 20)}`, 'ok')
    }
    case 'placeholder':
      return withValue(`占位符·${b.body}`, 'warn', '交给后端按参数类型渲染')
    case 'expr':
      return withValue(trunc(b.body, 24), 'ok')
    default:
      return withValue(trunc(b.body || '空', 24), 'bad', '不是合法引用')
  }
}
