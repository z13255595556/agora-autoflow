import type { JsonType } from './outputShape'
import type { MatchOperatorName } from './selectionFilters.ts'

/** 比较方式的唯一出处在 selectionFilters（引擎那边）。面板能选的就是引擎能跑的 */
export type MatchOperator = MatchOperatorName

/** 汇总函数。面板上的一个按钮 = 引擎里同名的一个过滤器 */
export type AggregateFn = 'sum' | 'avg' | 'min' | 'max'

export type ReferenceSelection =
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'field' | 'all'; valueType: JsonType; label: string }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'at'; index: number; column?: string; valueType: JsonType; label: string }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'first' | 'last'; column?: string; valueType: JsonType; label: string }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'column'; column: string; valueType: JsonType; label: string }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'table'; columns: string[]; valueType: 'string'; label: string }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'count'; valueType: 'integer'; label: string }
  | {
      sourceNodeId: string
      sourceLabel: string
      path: string
      mode: 'find'
      matchColumn: string
      operator: MatchOperator
      matchValue: string | number | boolean | null
      resultColumn?: string
      valueType: JsonType
      label: string
    }
  // ---- 第二批：筛选行 / 前 N / 汇总。都编译成现有管道，不新增节点种类
  | {
      sourceNodeId: string
      sourceLabel: string
      path: string
      mode: 'where'
      matchColumn: string
      operator: MatchOperator
      matchValue: string | number | boolean | null
      valueType: 'array'
      label: string
    }
  | {
      sourceNodeId: string
      sourceLabel: string
      path: string
      mode: 'top'
      sortColumn: string
      direction: 'asc' | 'desc'
      limit: number
      /** 给了列就接一段 | table(...)，结果是能直接进消息的表格 */
      columns?: string[]
      valueType: 'array' | 'string'
      label: string
    }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'aggregate'; fn: AggregateFn; column: string; valueType: 'number'; label: string }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'uniqueCount'; column: string; valueType: 'integer'; label: string }
  | { sourceNodeId: string; sourceLabel: string; path: string; mode: 'join'; column: string; separator: string; valueType: 'string'; label: string }

const arg = (value: unknown): string => {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value)
  // References are often inserted inside a JSON string (for example an HTTP
  // request body). Double-quoted filter arguments would terminate that JSON
  // string, so compile strings with the expression language's single quotes.
  const escaped = [...String(value)].map((char) => {
    switch (char) {
      case '\\': return '\\\\'
      case "'": return "\\'"
      case '\b': return '\\b'
      case '\f': return '\\f'
      case '\n': return '\\n'
      case '\r': return '\\r'
      case '\t': return '\\t'
      default: {
        const code = char.charCodeAt(0)
        return code < 0x20 ? `\\u${code.toString(16).padStart(4, '0')}` : char
      }
    }
  }).join('')
  return `'${escaped}'`
}

/** 把可视化选择编译成当前引擎可执行、旧流程可保存的表达式。 */
export function compileReferenceSelection(selection: ReferenceSelection): string {
  const base = selection.sourceNodeId
    ? `$.nodes.${selection.sourceNodeId}.output${selection.path ? `.${selection.path}` : ''}`
    : selection.path
  switch (selection.mode) {
    case 'field':
    case 'all':
      return `{{ ${base} }}`
    case 'at':
      return `{{ ${base} | at(${selection.index}${selection.column ? `, ${arg(selection.column)}` : ''}) }}`
    case 'first':
    case 'last':
      return `{{ ${base} | ${selection.mode}(${selection.column ? arg(selection.column) : ''}) }}`
    case 'column':
      return `{{ ${base} | column(${arg(selection.column)}) }}`
    case 'table':
      return `{{ ${base} | table(${selection.columns.map(arg).join(', ')}) }}`
    case 'count':
      return `{{ ${base} | count }}`
    case 'find':
      return `{{ ${base} | find(${arg(selection.matchColumn)}, ${selection.operator}, ${arg(selection.matchValue)}${selection.resultColumn ? `, ${arg(selection.resultColumn)}` : ''}) }}`
    case 'where':
      return `{{ ${base} | where(${arg(selection.matchColumn)}, ${selection.operator}, ${arg(selection.matchValue)}) }}`
    case 'top': {
      const table = selection.columns?.length ? ` | table(${selection.columns.map(arg).join(', ')})` : ''
      return `{{ ${base} | sort(${arg(selection.sortColumn)}, ${selection.direction}) | limit(${selection.limit})${table} }}`
    }
    case 'aggregate':
      return `{{ ${base} | ${selection.fn}(${arg(selection.column)}) }}`
    case 'uniqueCount':
      return `{{ ${base} | unique(${arg(selection.column)}) | count }}`
    case 'join':
      return `{{ ${base} | column(${arg(selection.column)}) | join(${arg(selection.separator)}) }}`
  }
}

export function selectionDisplayLabel(selection: ReferenceSelection): string {
  return selection.sourceLabel ? `${selection.sourceLabel} · ${selection.label}` : selection.label
}
