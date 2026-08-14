import { useMemo, useState } from 'react'
import type { VarEntry } from '../lib/vars'

interface Props {
  vars: VarEntry[]
  onPick: (path: string) => void
  onClose: () => void
}

/**
 * 变量选择器：按来源节点分组列出可引用的字段。
 * 这是编辑器的生死线 —— 没有它用户只能盲敲上游字段名，跑一次错一次。
 */
export default function VarPicker({ vars, onPick, onClose }: Props) {
  const [q, setQ] = useState('')

  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const hit = vars.filter(
      (v) => !kw || v.path.toLowerCase().includes(kw) || v.label.toLowerCase().includes(kw),
    )
    const map = new Map<string, VarEntry[]>()
    for (const v of hit) map.set(v.group, [...(map.get(v.group) ?? []), v])
    return [...map.entries()]
  }, [vars, q])

  return (
    <>
      <div className="varpicker__mask" onClick={onClose} />
      <div className="varpicker">
        <div className="varpicker__search">
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="搜索变量 / 日期函数…"
            // Esc 关掉。`/` 唤起时这里是误触的唯一出口，没有它只能去点遮罩
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                e.preventDefault()
                onClose()
              }
            }}
          />
        </div>
        <div className="varpicker__body">
          {groups.map(([group, items]) => (
            <div key={group} className="varpicker__group">
              <div className="varpicker__gtitle">{group}</div>
              {items.map((v) => (
                <button key={v.path} className="varpicker__item" onClick={() => onPick(v.path)}>
                  <span className="varpicker__label">{v.label}</span>
                  <code className="varpicker__path">{v.path}</code>
                  <span className="varpicker__type">
                    {v.type}
                    {v.large && <em title="大字段，节点间走 $ref 引用传递"> ·大</em>}
                  </span>
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && <div className="empty">没有可引用的变量。先把上游节点连过来。</div>}
        </div>
      </div>
    </>
  )
}
