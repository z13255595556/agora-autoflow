import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { CATEGORY_COLOR, NODE_TYPE_MAP } from '../registry'
import { useFlow } from '../store'
import { filterCommands, type Command } from '../lib/commands'
import Icon from './Icon'

const NODE_W = 244
const NODE_H = 76
const INSPECTOR_W = 424

export default function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[]
  onClose: () => void
}) {
  const nodes = useFlow((state) => state.nodes)
  const focusNode = useFlow((state) => state.focusNode)
  const { getNode, getZoom, setCenter } = useReactFlow()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)

  const filteredCommands = useMemo(() => filterCommands(commands, query), [commands, query])
  const nodeHits = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return []
    return nodes
      .filter((node) => {
        const type = NODE_TYPE_MAP.get(node.data.typeId)
        return [node.data.label, node.id, node.data.typeId, type?.name ?? ''].some((text) =>
          text.toLowerCase().includes(term),
        )
      })
      .slice(0, 8)
  }, [nodes, query])

  const rows: Array<{ id: string; run: () => void }> = [
    ...filteredCommands.map((item) => ({
      id: `cmd:${item.id}`,
      run: () => { if (item.enabled !== false) { item.run(); onClose() } },
    })),
    ...nodeHits.map((node) => ({
      id: `node:${node.id}`,
      run: () => {
        const found = getNode(node.id)
        focusNode(node.id)
        onClose()
        if (!found) return
        const width = found.measured?.width ?? found.width ?? NODE_W
        const height = found.measured?.height ?? found.height ?? NODE_H
        const zoom = getZoom()
        void setCenter(found.position.x + width / 2 + INSPECTOR_W / 2 / zoom, found.position.y + height / 2, {
          zoom,
          duration: 180,
        })
      },
    })),
  ]

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setCursor(0), [query])

  return (
    <div className="nodesearchbackdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
      <div className="nodesearch" role="dialog" aria-modal="true" aria-label="命令">
        <div className="nodesearch__input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="运行、添加节点、回首页，或跳转到某个节点"
            aria-label="命令"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((value) => Math.min(value + 1, rows.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((value) => Math.max(value - 1, 0))
              } else if (event.key === 'Enter' && rows[cursor]) {
                event.preventDefault()
                rows[cursor].run()
              }
            }}
          />
          <button className="nodesearch__close" onClick={onClose} title="关闭" aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>
        <div className="nodesearch__results" role="listbox">
          {filteredCommands.map((item, index) => (
            <button
              key={item.id}
              className={`nodesearch__item${index === cursor ? ' is-cursor' : ''}`}
              disabled={item.enabled === false}
              onMouseEnter={() => setCursor(index)}
              onClick={() => rows[index]?.run()}
            >
              <span className="nodesearch__meta">
                <b>{item.label}</b>
                <small>{item.group}{item.hint ? ` · ${item.hint}` : ''}</small>
              </span>
            </button>
          ))}
          {nodeHits.map((node, offset) => {
            const index = filteredCommands.length + offset
            const type = NODE_TYPE_MAP.get(node.data.typeId)
            return (
              <button
                key={node.id}
                className={`nodesearch__item${index === cursor ? ' is-cursor' : ''}`}
                onMouseEnter={() => setCursor(index)}
                onClick={() => rows[index]?.run()}
              >
                <span
                  className="nodesearch__icon"
                  style={{ '--accent': CATEGORY_COLOR[type?.category ?? ''] ?? '#64748b' } as React.CSSProperties}
                >
                  {type?.icon ?? '•'}
                </span>
                <span className="nodesearch__meta">
                  <b>{node.data.label}</b>
                  <small>跳转到节点</small>
                </span>
              </button>
            )
          })}
          {rows.length === 0 && <div className="nodesearch__empty">没有匹配的命令</div>}
        </div>
      </div>
    </div>
  )
}
