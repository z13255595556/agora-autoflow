const KEY = 'autoflow.recent-node-types.v1'
const MAX_RECENT = 5

/** 最近使用只影响节点选择器排序，存储失败不能影响编辑。 */
export function recentNodeTypes(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? '[]')
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, MAX_RECENT) : []
  } catch {
    return []
  }
}

export function rememberNodeType(type: string): void {
  try {
    const next = [type, ...recentNodeTypes().filter((item) => item !== type)].slice(0, MAX_RECENT)
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // 隐私模式或配额不足时退化为不记录，不阻断添加节点。
  }
}
