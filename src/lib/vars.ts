import type { Edge } from '@xyflow/react'
import type { JsonSchema } from '../types'
import { NODE_TYPE_MAP } from '../registry'
import type { FNode } from '../store'
import { isFieldVisible } from './display'
import { dateNodeError, datePresets } from './datefn'
import { FILTERS, probedColumns, probedContainer } from './output'
import { extractSqlPlaceholders } from './placeholders'
import { scheduleErrors } from './schedule'

export interface VarEntry {
  /** 插入到表达式里的引用路径 */
  path: string
  label: string
  type: string
  /** 来源节点显示名，仅用于分组展示 */
  group: string
  large?: boolean
}

/** 反向 BFS，找出某节点的全部上游节点（顺序：由近及远） */
export function upstreamNodes(nodeId: string, nodes: FNode[], edges: Edge[]): FNode[] {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map<string, string[]>()
  for (const e of edges) {
    incoming.set(e.target, [...(incoming.get(e.target) ?? []), e.source])
  }
  const seen = new Set<string>([nodeId])
  const queue = [...(incoming.get(nodeId) ?? [])]
  const result: FNode[] = []
  while (queue.length) {
    const id = queue.shift()!
    if (seen.has(id)) continue
    seen.add(id)
    const n = byId.get(id)
    if (n) result.push(n)
    queue.push(...(incoming.get(id) ?? []))
  }
  return result
}

/** 把一层输出 schema 摊平成可点击的变量路径 */
function flatten(prefix: string, schema: JsonSchema, group: string, out: VarEntry[], depth = 0) {
  if (depth > 2) return
  for (const [key, sub] of Object.entries(schema.properties ?? {})) {
    const path = `${prefix}.${key}`
    out.push({
      path,
      label: sub.title ?? key,
      type: sub.type === 'array' ? `${sub.items?.type ?? 'any'}[]` : (sub.type ?? 'any'),
      group,
      large: sub['x-large'],
    })
    if (sub.type === 'object' && sub.properties) flatten(path, sub, group, out, depth + 1)
  }
}

/**
 * 给定当前节点，算出所有它能引用的变量。
 * 这是整个编辑器最关键的能力 —— 没有它，用户只能盲敲字段名。
 */
export function availableVars(
  nodeId: string | null,
  nodes: FNode[],
  edges: Edge[],
  flowInputKeys: Array<{ key: string; title: string; type: string }>,
): VarEntry[] {
  const out: VarEntry[] = []

  for (const f of flowInputKeys) {
    out.push({ path: `$.trigger.${f.key}`, label: f.title || f.key, type: f.type, group: '流程入参' })
  }
  out.push({ path: '$.run.id', label: '运行 ID', type: 'string', group: '运行上下文' })
  out.push({ path: '$.run.startedAt', label: '开始时间', type: 'string', group: '运行上下文' })

  // 日期函数走的也是"插入一段 {{ }}"这条路，所以直接借变量选择器展示，
  // 不另做一个 UI。定时触发没人填表单，日期只能这么来。
  for (const p of datePresets()) {
    out.push({ path: p.expr, label: p.label, type: 'string', group: '日期函数' })
  }

  if (!nodeId) return out

  const ups = upstreamNodes(nodeId, nodes, edges)
  // 在循环体内（上游有 foreach）→ 提供 $.loop.*
  if (ups.some((n) => n.data.typeId === 'flow.foreach')) {
    out.push({ path: '$.loop.item', label: '当前项', type: 'any', group: '循环上下文' })
    out.push({ path: '$.loop.index', label: '当前序号', type: 'integer', group: '循环上下文' })
  }

  for (const up of ups) {
    const t = NODE_TYPE_MAP.get(up.data.typeId)
    if (!t) continue
    flatten(`$.nodes.${up.id}.output`, t.output, `${up.data.label} (${up.id})`, out)
    // 这里**不要**把探测到的列名也当成变量路径列出来。
    //
    // 曾经列过，形如 $.nodes.n2.output.rows[].vid —— 但 lookupPath 按 . [ ]
    // 切分，rows[].vid 变成 rows.vid，对数组按字符串取值得到 undefined，在
    // 混合文本里渲染成空字符串；而 validateNode 因为路径完全相等还判它合法。
    // 唯一为解决"列名"而做的功能，在它唯一的真实场景下静默失效。
    //
    // 列名不属于变量路径这个命名空间，它是 | table(列…) 的参数，
    // 由 upstreamColumns 供给选列器。
  }
  return out
}

/**
 * 全流程的变量清单，给顶部「变量」面板用。
 *
 * 和 availableVars 的区别：那个按「当前节点能不能引用」过滤（只列上游），
 * 这个是**通讯录**，把画布上每个节点的输出都列出来供查阅和复制。
 * 所以每条带上 nodeId，面板据此提示"只有它的下游能引用"。
 */
export function allVars(
  nodes: FNode[],
  edges: Edge[],
  flowInputKeys: Array<{ key: string; title: string; type: string }>,
): VarEntry[] {
  const out = availableVars(null, nodes, edges, flowInputKeys)
  for (const n of nodes) {
    const t = NODE_TYPE_MAP.get(n.data.typeId)
    if (!t) continue
    flatten(`$.nodes.${n.id}.output`, t.output, `${n.data.label} (${n.id})`, out)
  }
  // 循环体存在时 $.loop.* 才有意义，和 availableVars 一个判断
  if (nodes.some((n) => n.data.typeId === 'flow.foreach')) {
    out.push({ path: '$.loop.item', label: '当前项', type: 'any', group: '循环上下文' })
    out.push({ path: '$.loop.index', label: '当前序号', type: 'integer', group: '循环上下文' })
  }
  return out
}

/**
 * 每个上游节点已学到的真实列名，供选列器 / 消息预览用。
 *
 * 列名从每次成功运行里学（见 store.withLearnedColumns），没跑过的节点
 * 就是空数组 —— 调用方据此提示"先跑一次"。
 */
export function upstreamColumns(
  nodeId: string,
  nodes: FNode[],
  edges: Edge[],
): Array<{ nodeId: string; label: string; container: string; columns: Array<{ name: string; type?: string }> }> {
  return upstreamNodes(nodeId, nodes, edges)
    .map((up) => ({
      nodeId: up.id,
      label: `${up.data.label} (${up.id})`,
      container: probedContainer(up.data.probedOutput),
      columns: probedColumns(up.data.probedOutput),
    }))
    .filter((x) => x.columns.length > 0)
}

/** 从字符串里抽出所有 {{ ... }} 引用 */
export function extractRefs(value: string): string[] {
  return [...value.matchAll(/\{\{([^}]*)\}\}/g)]
    .flatMap((m) => [...m[1].matchAll(/\$\.[A-Za-z0-9_.[\]]+/g)].map((r) => r[0]))
}

/** 抽出所有 {{ }} 块的原始内容，用于识别写错的引用 */
export function extractBlocks(value: string): string[] {
  return [...value.matchAll(/\{\{([^}]*)\}\}/g)].map((m) => m[1].trim())
}

const LITERAL_RE = /^(-?\d+(\.\d+)?|true|false|null|(["']).*\3)$/

/**
 * 一个 {{ }} 块里没有任何 $. 引用，也不是纯字面量 —— 十有八九是写错了。
 *
 * 最典型的是把 SQL 占位符写成了 `{{date}}`：引擎会把裸标识符原样还回去，
 * SQL 变成 `where date = date`，恒真且全表扫，静默出错。
 */
export function isBrokenBlock(block: string): boolean {
  if (!block) return true
  if (block.includes('$.')) return false
  // 函数调用，比如 date('now-1d','yyyyMMdd')。参数对不对由运行/预览时报错，
  // 这里只负责别把它当成写错的引用
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(block.trim())) return false
  // 去掉比较运算符后逐个看操作数
  return block
    .split(/(?:===|!==|==|!=|>=|<=|>|<)/)
    .map((s) => s.trim())
    .some((s) => s !== '' && !LITERAL_RE.test(s))
}

/**
 * 保存期静态校验：引用了不存在的上游字段就报出来。
 * 表达式引擎选 CEL/expr 这类无副作用方案，才能做到这一步。
 */
export function validateNode(
  node: FNode,
  nodes: FNode[],
  edges: Edge[],
  flowInputKeys: Array<{ key: string; title: string; type: string }>,
): string[] {
  const errors: string[] = []
  const t = NODE_TYPE_MAP.get(node.data.typeId)
  if (!t) return [`未知节点类型 ${node.data.typeId}`]

  // 定时触发的参数是互相依赖的（选了哪个 mode 才轮到哪个字段必填），
  // 通用的 required 表达不了，单独查一道
  if (node.data.typeId === 'trigger.schedule') {
    errors.push(...scheduleErrors(node.data.params))
  }

  // 日期节点的偏移/格式串写错了在这里就拦下 —— 运行期再抛就成了逃出引擎的异常
  if (node.data.typeId === 'date.compute') {
    const err = dateNodeError(node.data.params)
    if (err) errors.push(err)
  }

  for (const key of t.input.required ?? []) {
    // 被 x-show/x-hide 隐藏的字段不做必填校验（n8n 同款行为）
    if (!isFieldVisible(key, t.input, node.data.params)) continue
    const v = node.data.params[key]
    if (v === undefined || v === '' || v === null) {
      errors.push(`必填项「${t.input.properties?.[key]?.title ?? key}」未填`)
    }
  }

  const knownPaths = availableVars(node.id, nodes, edges, flowInputKeys).map((v) => v.path)
  // 前缀命中即可：$.loop.item.vid 属于已知的 $.loop.item
  const isKnown = (ref: string) =>
    knownPaths.some((k) => ref === k || ref.startsWith(`${k}.`) || ref.startsWith(`${k}[`))
  const upstreamIds = new Set(upstreamNodes(node.id, nodes, edges).map((n) => n.id))
  for (const [key, value] of Object.entries(node.data.params)) {
    if (typeof value !== 'string') continue
    // 隐藏字段里的引用不参与校验（值保留但不生效）
    if (!isFieldVisible(key, t.input, node.data.params)) continue
    const ph = t.input.properties?.[key]?.['x-placeholders']
    if (ph) {
      // 这个字段自带占位符语法：两种写法都要检查值凑不凑得齐 ——
      // 要么显式填在 valuesFrom 指定的字段里，要么有同名流程入参
      const bag = node.data.params[ph.valuesFrom]
      const explicit = (name: string) =>
        bag && typeof bag === 'object' ? name in (bag as object) : false
      for (const { name, written } of extractSqlPlaceholders(value)) {
        if (explicit(name) || flowInputKeys.some((f) => f.key === name)) continue
        errors.push(
          `占位符 ${written} 没有值：加一个名为 ${name} 的流程入参，或在「占位符参数」里填它`,
        )
      }
    }
    for (const block of extractBlocks(value)) {
      if (!isBrokenBlock(block)) continue
      const isBareName = /^[A-Za-z_][A-Za-z0-9_]*$/.test(block)
      if (ph && isBareName) continue // 上面已按占位符规则查过
      errors.push(
        `「${key}」里的 {{ ${block} }} 不是合法引用` +
          (isBareName
            ? `：想引用流程入参写 {{ $.trigger.${block} }}，想写 SQL 占位符写 :${block}`
            : ''),
      )
    }
    // 过滤器**名字**写错在这里就能发现。以前要等到运行期 applyFilter 抛错，
    // 而那个抛错会逃出 executeFlow 把运行记录变成僵尸。
    //
    // 只校验名字，不校验列名 —— validateNode 的返回值会阻断执行，而列名可能
    // 只是还没跑过所以没学到。列名写错交给消息预览提示，不拦。
    for (const block of extractBlocks(value)) {
      const m = block.match(/\|\s*([A-Za-z_]+)/)
      if (m && !FILTERS.includes(m[1] as (typeof FILTERS)[number])) {
        errors.push(`「${key}」里的过滤器 |${m[1]} 不存在，可用：${FILTERS.join(' / ')}`)
      }
    }

    for (const ref of extractRefs(value)) {
      if (isKnown(ref)) continue
      const m = ref.match(/^\$\.nodes\.([^.]+)\./)
      if (m && !upstreamIds.has(m[1])) {
        errors.push(`「${key}」引用了非上游节点 ${m[1]}`)
      } else if (!ref.startsWith('$.nodes.')) {
        errors.push(`「${key}」引用了未知变量 ${ref}`)
      }
    }
  }
  return errors
}
