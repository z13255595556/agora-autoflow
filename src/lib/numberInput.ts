/**
 * 数字输入框的两条纯规则。抽出来是为了能脱开 DOM 测 —— 这个项目没有 jsdom 基座，
 * 而这两条恰恰是最容易写错、也最容易被改回去的地方。
 *
 * 背景：SchemaForm 里字段的值是 `values[key] === undefined ? sub.default : values[key]`。
 * 直接做受控 input 的话，把输入框清空会把值置成 undefined，默认值立刻被填回来 ——
 * 于是「把 15 删掉改成 20」根本做不到：退格两下，15 自己回来了。有 default 的
 * 数字字段全都中招（超时时间、行数上限、HTTP 超时……）。
 */

/**
 * 输入框此刻该显示什么。
 *
 * `draft` 是编辑中的原始文本，null 表示没在编辑。**空字符串必须原样显示**，
 * 不能因为它"假"就退回 props —— 那就是删不掉的根源。
 */
export function displayNumber(draft: string | null, value: number | undefined | null): string {
  if (draft !== null) return draft
  return value === undefined || value === null ? '' : String(value)
}

export interface NumberBounds {
  min?: number
  max?: number
  integer?: boolean
}

/**
 * 失焦时把草稿定下来。undefined = 交还给默认值。
 *
 * **夹到边界只在这里做，不在每次按键时做。** 按键时夹的话，上限 120 的字段里
 * 想输入 20 会在打完 "2" 的瞬间被弹到别处 —— 比删不掉还难用。
 */
export function commitNumber(text: string, { min, max, integer }: NumberBounds = {}): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const n = Number(trimmed)
  // 非数字当成"没填"，而不是留一个 NaN 在流程定义里
  if (!Number.isFinite(n)) return undefined
  const rounded = integer ? Math.round(n) : n
  return Math.min(max ?? Infinity, Math.max(min ?? -Infinity, rounded))
}
