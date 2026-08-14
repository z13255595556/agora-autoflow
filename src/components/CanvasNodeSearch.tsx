import { useEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { CATEGORY_COLOR, NODE_TYPE_MAP } from '../registry'
import { useFlow } from '../store'
import Icon from './Icon'

const NODE_W = 244
const NODE_H = 76
const INSPECTOR_W = 424

export default function CanvasNodeSearch({ onClose }: { onClose: () => void }) {
  const nodes = useFlow((state) => state.nodes)
  const focusNode = useFlow((state) => state.focusNode)
  const { getNode, getZoom, setCenter } = useReactFlow()
  const [query, setQuery] = useState('')
  const [cursor, setCursor] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const itemRefs = useRef(new Map<string, HTMLButtonElement>())

  const results = useMemo(() => {
    const term = query.trim().toLowerCase()
    return nodes
      .map((node, index) => {
        const type = NODE_TYPE_MAP.get(node.data.typeId)
        const id = node.id.toLowerCase()
        const label = node.data.label.toLowerCase()
        const typeId = node.data.typeId.toLowerCase()
        const typeName = type?.name.toLowerCase() ?? ''
        const description = type?.description?.toLowerCase() ?? ''
        let score = term ? 0 : 1

        if (term) {
          if (id === term) score += 120
          else if (id.startsWith(term)) score += 90
          else if (id.includes(term)) score += 40

          if (label.startsWith(term)) score += 100
          else if (label.includes(term)) score += 50

          if (typeName === term || typeId === term) score += 80
          else if (typeName.includes(term) || typeId.includes(term)) score += 30
          if (description.includes(term)) score += 20
        }

        return { node, type, score, index }
      })
      .filter((item) => item.score > 0)
      .sort((a, b) => {
        if (term) return b.score - a.score || a.index - b.index
        return a.node.position.x - b.node.position.x || a.node.position.y - b.node.position.y
      })
  }, [nodes, query])

  useEffect(() => inputRef.current?.focus(), [])
  useEffect(() => setCursor(0), [query])
  useEffect(() => {
    const active = results[cursor]
    if (active) itemRefs.current.get(active.node.id)?.scrollIntoView({ block: 'nearest' })
  }, [cursor, results])

  const choose = (id: string) => {
    const node = getNode(id)
    focusNode(id)
    onClose()
    if (!node) return
    const width = node.measured?.width ?? node.width ?? NODE_W
    const height = node.measured?.height ?? node.height ?? NODE_H
    const zoom = getZoom()
    void setCenter(node.position.x + width / 2 + INSPECTOR_W / 2 / zoom, node.position.y + height / 2, {
      zoom,
      duration: 180,
    })
  }

  return (
    <div
      className="nodesearchbackdrop"
      onPointerDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="nodesearch" role="dialog" aria-modal="true" aria-label="查找节点">
        <div className="nodesearch__input">
          <Icon name="search" size={16} />
          <input
            ref={inputRef}
            value={query}
            placeholder="搜索节点名称、类型或 ID"
            aria-label="搜索节点名称、类型或 ID"
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                onClose()
              } else if (event.key === 'ArrowDown') {
                event.preventDefault()
                setCursor((value) => Math.min(value + 1, results.length - 1))
              } else if (event.key === 'ArrowUp') {
                event.preventDefault()
                setCursor((value) => Math.max(value - 1, 0))
              } else if (event.key === 'Home') {
                event.preventDefault()
                setCursor(0)
              } else if (event.key === 'End') {
                event.preventDefault()
                setCursor(Math.max(0, results.length - 1))
              } else if (event.key === 'Enter' && results[cursor]) {
                event.preventDefault()
                choose(results[cursor].node.id)
              }
            }}
          />
          <button className="nodesearch__close" onClick={onClose} title="关闭" aria-label="关闭">
            <Icon name="close" size={14} />
          </button>
        </div>

        <div className="nodesearch__results" role="listbox" aria-label="流程节点">
          {results.map(({ node, type }, index) => (
            <button
              key={node.id}
              ref={(element) => {
                if (element) itemRefs.current.set(node.id, element)
                else itemRefs.current.delete(node.id)
              }}
              className={`nodesearch__item${index === cursor ? ' is-cursor' : ''}`}
              role="option"
              aria-selected={index === cursor}
              onMouseEnter={() => setCursor(index)}
              onClick={() => choose(node.id)}
            >
              <span
                className="nodesearch__icon"
                style={{ '--accent': CATEGORY_COLOR[type?.category ?? ''] ?? '#64748b' } as React.CSSProperties}
              >
                {type?.icon ?? '•'}
              </span>
              <span className="nodesearch__meta">
                <b>{node.data.label}</b>
                <small>
                  {type?.name && type.name !== node.data.label ? `${type.name} · ` : ''}
                  {node.data.typeId}
                </small>
              </span>
              <code>{node.id}</code>
            </button>
          ))}
          {results.length === 0 && <div className="nodesearch__empty">没有匹配的节点</div>}
        </div>

        <div className="nodesearch__foot">
          <span>{results.length} 个节点</span>
        </div>
      </div>
    </div>
  )
}
