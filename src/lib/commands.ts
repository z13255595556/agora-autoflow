export interface Command {
  id: string
  group: '流程' | '节点' | '运行' | '导航'
  label: string
  hint?: string
  enabled?: boolean
  run: () => void
}

export function filterCommands(commands: Command[], query: string): Command[] {
  const keyword = query.trim().toLowerCase()
  if (!keyword) return commands
  return commands.filter((item) =>
    item.label.toLowerCase().includes(keyword)
    || item.group.toLowerCase().includes(keyword)
    || (item.hint ?? '').toLowerCase().includes(keyword),
  )
}
