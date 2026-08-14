import type { CSSProperties } from 'react'
import { useEffect, useMemo, useRef } from 'react'
import type { VarEntry } from '../lib/vars'
import { filterSlashVars } from '../lib/slash'

interface Props {
  vars: VarEntry[]
  query: string
  activeIndex: number
  style: CSSProperties
  onPick: (path: string) => void
  onActiveIndex: (index: number) => void
}

/**
 * Slash variable picker. Search happens in the source text after `/`, so the
 * popup itself deliberately has no second search box and never steals focus.
 */
export default function VarPicker({ vars, query, activeIndex, style, onPick, onActiveIndex }: Props) {
  const activeRef = useRef<HTMLButtonElement>(null)
  const filtered = useMemo(() => filterSlashVars(vars, query), [vars, query])
  const groups = useMemo(() => {
    const map = new Map<string, Array<{ item: VarEntry; index: number }>>()
    filtered.forEach((item, index) => {
      map.set(item.group, [...(map.get(item.group) ?? []), { item, index }])
    })
    return [...map.entries()]
  }, [filtered])

  useEffect(() => {
    activeRef.current?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  if (filtered.length === 0) return null

  return (
    <div className="varpicker" style={style} role="listbox" aria-label="可用变量">
      <div className="varpicker__body">
        {groups.map(([group, items]) => (
          <div key={group} className="varpicker__group">
            <div className="varpicker__gtitle">{group}</div>
            {items.map(({ item, index }) => (
              <button
                key={item.path}
                ref={index === activeIndex ? activeRef : undefined}
                className={`varpicker__item${index === activeIndex ? ' is-active' : ''}`}
                role="option"
                aria-selected={index === activeIndex}
                onMouseEnter={() => onActiveIndex(index)}
                onMouseDown={(event) => {
                  event.preventDefault()
                  onPick(item.path)
                }}
              >
                <span className="varpicker__label">{item.label}</span>
                <code className="varpicker__path">{item.path}</code>
                <span className="varpicker__type">
                  {item.type}
                  {item.large && <em title="大字段，节点间走 $ref 引用传递"> ·大</em>}
                </span>
              </button>
            ))}
          </div>
        ))}
      </div>
    </div>
  )
}
