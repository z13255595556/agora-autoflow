import type { VarEntry } from './vars'

export interface SlashMatch {
  start: number
  end: number
  query: string
}

/** 光标前最后一个 `/` 开始变量检索；它可以出现在输入内容的任意位置。 */
export function slashMatchAt(value: string, caret: number | null): SlashMatch | null {
  if (caret === null) return null
  const beforeCaret = value.slice(0, caret)
  const match = /\/([^/\n\r]{0,75})$/.exec(beforeCaret)
  if (!match) return null

  const replaceable = `/${match[1]}`
  return {
    start: caret - replaceable.length,
    end: caret,
    query: match[1],
  }
}

export function filterSlashVars(vars: VarEntry[], query: string): VarEntry[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return vars
  return vars.filter(
    (item) =>
      item.label.toLowerCase().includes(keyword) ||
      item.path.toLowerCase().includes(keyword) ||
      item.group.toLowerCase().includes(keyword),
  )
}
