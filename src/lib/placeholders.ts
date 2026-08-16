/**
 * 从 SQL 里认出占位符，供表单自动列出参数行。
 *
 * 规则和后端 sqlparams.py 的扫描器保持一致：跳过字符串、注释、`::` 转型，
 * 两种写法都认（`:name` 和 `{{name}}`）。这里只是给编辑器做提示，
 * 真正的替换和校验仍以后端为准 —— 两边不一致时后端说了算。
 */

export interface Placeholder {
  name: string
  /** 用户实际写的形式，报错和提示时回显用 */
  written: string
}

/** 返回需要跳过的区间：字符串字面量、标识符引号、注释 */
function skipRegions(sql: string): Array<[number, number]> {
  const regions: Array<[number, number]> = []
  let i = 0
  const n = sql.length
  while (i < n) {
    const ch = sql[i]
    if (ch === '-' && sql.startsWith('--', i)) {
      const end = sql.indexOf('\n', i)
      regions.push([i, end < 0 ? n : end])
      i = end < 0 ? n : end
    } else if (ch === '/' && sql.startsWith('/*', i)) {
      const end = sql.indexOf('*/', i + 2)
      regions.push([i, end < 0 ? n : end + 2])
      i = end < 0 ? n : end + 2
    } else if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch
      let j = i + 1
      while (j < n) {
        if (sql[j] === '\\') { j += 2; continue }
        if (sql[j] === quote) {
          // '' 是引号自身的转义，不算结束
          if (quote === "'" && sql[j + 1] === "'") { j += 2; continue }
          j += 1
          break
        }
        j += 1
      }
      regions.push([i, Math.min(j, n)])
      i = Math.min(j, n)
    } else {
      i += 1
    }
  }
  return regions
}

/**
 * SQL 里的"死区"判定：字符串字面量和注释。
 *
 * 死区里的裸 `{{name}}` 前后端都不会替换它（后端的 BRACE_RE 同样跳过这些区间），
 * 所以它就是字面文本 —— 胶囊编辑器据此不把它画成占位符。
 *
 * 注意这**只**管裸标识符。`'{{ $.x }}'` 这种带 $. 的引用在引号里照样会被
 * resolvePreservingPlaceholders 替换掉（registry 里的 SQL 模板就是这么写的），
 * 那种仍然是货真价实的引用。
 */
export function sqlInertAt(sql: string): (pos: number) => boolean {
  const regions = skipRegions(sql)
  return (pos: number) => regions.some(([s, e]) => pos >= s && pos < e)
}

/**
 * SQL 里有没有真正的 ORDER BY。
 *
 * 没有的话「第 N 行」就不稳定 —— 在 Hive / Doris 上行序由执行计划决定，两次
 * 同样的查询可以给出不同顺序。「最后一行」更是干脆没有意义。取值面板据此
 * 禁用/提示，让用户改用「按条件查找」。
 *
 * 复用 sqlInertAt 的跳区：`-- order by` 和 `'order by'` 都不算。
 */
export function hasOrderBy(sql: string): boolean {
  if (!sql) return false
  const inSkip = sqlInertAt(sql)
  return [...sql.matchAll(/\border\s+by\b/gi)].some((m) => m.index !== undefined && !inSkip(m.index))
}

export function extractSqlPlaceholders(sql: string): Placeholder[] {
  if (!sql) return []
  const inSkip = sqlInertAt(sql)

  const found: Array<{ at: number; name: string; written: string }> = []

  for (const m of sql.matchAll(/:([A-Za-z_][A-Za-z0-9_]*)/g)) {
    if (m.index === undefined) continue
    if (m.index > 0 && sql[m.index - 1] === ':') continue // a::int 是转型
    if (inSkip(m.index)) continue
    found.push({ at: m.index, name: m[1], written: m[0] })
  }
  for (const m of sql.matchAll(/\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}/g)) {
    if (m.index === undefined || inSkip(m.index)) continue
    found.push({ at: m.index, name: m[1], written: m[0] })
  }

  // 按出现顺序去重 —— 表单里的行序跟 SQL 里读到的顺序一致，好对照
  found.sort((a, b) => a.at - b.at)
  const seen = new Set<string>()
  const out: Placeholder[] = []
  for (const f of found) {
    if (seen.has(f.name)) continue
    seen.add(f.name)
    out.push({ name: f.name, written: f.written })
  }
  return out
}
