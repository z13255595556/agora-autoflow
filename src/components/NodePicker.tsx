import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { CATEGORY_COLOR, CATEGORY_ORDER, NODE_TYPES, portsOf } from '../registry'
import { useFlow } from '../store'
import type { NodeType } from '../types'
import type { PickTarget } from './canvasCtx'

/**
 * 节点选择器。
 *
 * 取代了原来常驻左侧的节点面板 —— 那一栏 244px 一直占着，而加节点是低频操作，
 * 代价却是画布一直窄一截。改成弹出式之后有三个入口（画布左上角、节点右侧的
 * `+`、连线中间的 `+`），后两个还顺手把线连好，加节点从"拖准 + 拉线"两步
 * 精确操作变成点两下。
 *
 * 拖拽仍然保留：从列表里把节点拖到画布上可以自己选落点。判定是"按下后移动
 * 超过阈值才算拖"，所以单击 = 加到默认位置，两种习惯都照顾到。
 */

const NODE_W = 244
const NODE_H = 76
const DRAG_THRESHOLD = 4
const PANEL_W = 300
const PANEL_MAX_H = 460

interface DragState {
  type: NodeType
  pointerId: number
  startX: number
  startY: number
  started: boolean
  origin: HTMLElement
}

const canvasEl = () => document.querySelector<HTMLElement>('.canvas')

export default function NodePicker({
  anchor,
  target,
  onClose,
}: {
  anchor: { x: number; y: number }
  target: PickTarget
  onClose: () => void
}) {
  const [q, setQ] = useState('')
  const registryVersion = useFlow((s) => s.registryVersion)
  const addNode = useFlow((s) => s.addNode)
  const addNodeAfter = useFlow((s) => s.addNodeAfter)
  const insertNodeOnEdge = useFlow((s) => s.insertNodeOnEdge)
  const { screenToFlowPosition, getZoom } = useReactFlow()

  const boxRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const drag = useRef<DragState | null>(null)
  const pos = useRef({ x: 0, y: 0 })
  const size = useRef({ w: NODE_W, h: NODE_H })
  const ghostRef = useRef<HTMLDivElement>(null)
  const [ghost, setGhost] = useState<NodeType | null>(null)

  // 打开就聚焦搜索框：这个面板基本只有一种用法 —— 打字找节点
  useEffect(() => searchRef.current?.focus(), [])

  // 点面板外 / Esc 关闭
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (drag.current) return
      if (!boxRef.current?.contains(e.target as Node)) onClose()
    }
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
    }
    // 捕获阶段：画布自己也监听 pointerdown，不抢先关掉的话会先选中节点
    document.addEventListener('pointerdown', onDown, true)
    window.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown, true)
      window.removeEventListener('keydown', onKey)
    }
  }, [onClose])

  const grouped = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const hit = NODE_TYPES.filter((t) => {
      // 接在别的节点后面时，没有输入口的触发器排掉 —— 选了也连不上
      if (target.kind !== 'free' && t.hasInput === false) return false
      return (
        !kw ||
        t.name.toLowerCase().includes(kw) ||
        t.type.toLowerCase().includes(kw) ||
        (t.description ?? '').toLowerCase().includes(kw)
      )
    })
    return CATEGORY_ORDER.map((c) => ({ category: c, items: hit.filter((t) => t.category === c) })).filter(
      (g) => g.items.length > 0,
    )
  }, [q, target.kind, registryVersion])

  const flat = useMemo(() => grouped.flatMap((g) => g.items), [grouped])
  const [cursor, setCursor] = useState(0)
  useEffect(() => setCursor(0), [q])

  /** 按选择器的来源决定加到哪、要不要连线 */
  const commit = useCallback(
    (t: NodeType, dropAt?: { x: number; y: number }) => {
      if (dropAt) {
        const p = screenToFlowPosition(dropAt)
        addNode(t.type, { x: p.x - size.current.w / 2, y: p.y - size.current.h / 2 })
      } else if (target.kind === 'after') {
        addNodeAfter(t.type, target.nodeId, target.port)
      } else if (target.kind === 'edge') {
        insertNodeOnEdge(t.type, target.edgeId)
      } else {
        // 空白处点开的：落在画布可视区域中间偏左，一定看得见
        const rect = canvasEl()?.getBoundingClientRect()
        const p = screenToFlowPosition(
          rect ? { x: rect.left + rect.width * 0.38, y: rect.top + rect.height / 2 } : { x: anchor.x, y: anchor.y },
        )
        addNode(t.type, { x: p.x - NODE_W / 2, y: p.y - NODE_H / 2 })
      }
      onClose()
    },
    [addNode, addNodeAfter, insertNodeOnEdge, target, anchor, screenToFlowPosition, onClose],
  )

  // ------------------------------------------------------------ 拖拽落点
  const paint = (x: number, y: number) => {
    pos.current = { x, y }
    const el = ghostRef.current
    if (!el) return
    // 跟着画布缩放一起缩，否则缩小视图时拖着个巨大的框、松手却落下个小节点
    const z = getZoom()
    const { w, h } = size.current
    el.style.transform = `translate3d(${x - (w * z) / 2}px, ${y - (h * z) / 2}px, 0) scale(${z})`
  }

  useLayoutEffect(() => {
    if (!ghost) return
    const box = ghostRef.current?.firstElementChild as HTMLElement | null
    if (box) size.current = { w: box.offsetWidth || NODE_W, h: box.offsetHeight || NODE_H }
    paint(pos.current.x, pos.current.y)
  }, [ghost])

  const endDrag = useCallback(
    (drop?: { x: number; y: number }) => {
      const d = drag.current
      drag.current = null
      if (d) {
        try {
          d.origin.releasePointerCapture(d.pointerId)
        } catch {
          /* 指针已经抬起或被系统收走，忽略 */
        }
      }
      setGhost(null)
      document.body.classList.remove('is-dragging-node')
      canvasEl()?.classList.remove('canvas--dropzone')
      if (!d) return

      if (!d.started) {
        commit(d.type) // 没拖动 = 单击
        return
      }
      if (!drop) return
      const rect = canvasEl()?.getBoundingClientRect()
      if (!rect) return
      const inside = drop.x >= rect.left && drop.x <= rect.right && drop.y >= rect.top && drop.y <= rect.bottom
      if (!inside) return // 丢在面板上/画布外 —— 当作取消，不要偷偷塞个节点到角落
      commit(d.type, drop)
    },
    [commit],
  )

  useEffect(() => {
    if (!ghost) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') endDrag()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ghost, endDrag])

  const onPointerDown = (e: React.PointerEvent, t: NodeType) => {
    if (e.button !== 0) return
    const origin = e.currentTarget as HTMLElement
    try {
      origin.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已失效就退回冒泡路径，拖拽照常，只是移出面板可能丢事件 */
    }
    drag.current = { type: t, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, started: false, origin }
  }

  const onPointerMove = (e: React.PointerEvent) => {
    const d = drag.current
    if (!d || e.pointerId !== d.pointerId) return
    if (!d.started) {
      if (Math.hypot(e.clientX - d.startX, e.clientY - d.startY) < DRAG_THRESHOLD) return
      d.started = true
      pos.current = { x: e.clientX, y: e.clientY }
      setGhost(d.type)
      document.body.classList.add('is-dragging-node')
    }
    e.preventDefault()
    paint(e.clientX, e.clientY)
    const rect = canvasEl()?.getBoundingClientRect()
    const over =
      !!rect && e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom
    canvasEl()?.classList.toggle('canvas--dropzone', over)
  }

  // ------------------------------------------------------------ 定位
  // 锚点在按钮下方；贴到视口边上就翻到另一侧，免得面板被切掉一半
  const style = useMemo(() => {
    const vw = window.innerWidth
    const vh = window.innerHeight
    const left = Math.min(Math.max(12, anchor.x - PANEL_W / 2), vw - PANEL_W - 12)
    const below = anchor.y + 10
    const flip = below + PANEL_MAX_H > vh - 12 && anchor.y - PANEL_MAX_H - 24 > 12
    return {
      left,
      top: flip ? undefined : Math.min(below, Math.max(12, vh - PANEL_MAX_H - 12)),
      bottom: flip ? vh - anchor.y + 24 : undefined,
    }
  }, [anchor])

  const title =
    target.kind === 'after' ? '接一个节点' : target.kind === 'edge' ? '插入到这条连线中间' : '添加节点'

  return (
    <>
      <div className="picker" ref={boxRef} style={style}>
        <div className="picker__head">
          <span className="picker__title">{title}</span>
          <span className="picker__hint">拖到画布可自选位置</span>
        </div>
        <div className="picker__search">
          <input
            ref={searchRef}
            value={q}
            placeholder="搜索节点…"
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowDown') {
                e.preventDefault()
                setCursor((c) => Math.min(c + 1, flat.length - 1))
              } else if (e.key === 'ArrowUp') {
                e.preventDefault()
                setCursor((c) => Math.max(c - 1, 0))
              } else if (e.key === 'Enter' && flat[cursor]) {
                e.preventDefault()
                commit(flat[cursor])
              }
            }}
          />
        </div>
        <div className="picker__body">
          {grouped.map((g) => (
            <section className="picker__group" key={g.category}>
              <div className="picker__cat">{g.category}</div>
              {g.items.map((t) => (
                <div
                  key={t.type}
                  className={`picker__item${flat[cursor]?.type === t.type ? ' is-cursor' : ''}`}
                  onPointerDown={(e) => onPointerDown(e, t)}
                  onPointerMove={onPointerMove}
                  onPointerUp={(e) => {
                    if (drag.current?.pointerId !== e.pointerId) return
                    endDrag({ x: e.clientX, y: e.clientY })
                  }}
                  onPointerCancel={() => {
                    drag.current = null
                    setGhost(null)
                    document.body.classList.remove('is-dragging-node')
                  }}
                  onMouseEnter={() => setCursor(flat.findIndex((x) => x.type === t.type))}
                  title={t.description}
                >
                  <span className="picker__icon" style={{ '--accent': CATEGORY_COLOR[t.category] } as React.CSSProperties}>
                    {t.icon}
                  </span>
                  <div className="picker__meta">
                    <div className="picker__name">{t.name}</div>
                    <div className="picker__desc">{t.description}</div>
                  </div>
                </div>
              ))}
            </section>
          ))}
          {grouped.length === 0 && <div className="empty">没有匹配的节点</div>}
        </div>
      </div>

      {ghost && (
        <div className="picker__ghost" ref={ghostRef}>
          <NodePreview type={ghost} />
        </div>
      )}
    </>
  )
}

/**
 * 拖拽时跟着指针走的节点本体。刻意复用 .node 那套类名，和画布上真实节点
 * 长得一模一样 —— 不用 FlowNodeView 是因为它内部的 <Handle> 必须活在
 * ReactFlow 的节点上下文里，这里用同样样式的圆点顶上。
 */
function NodePreview({ type }: { type: NodeType }) {
  const ports = portsOf(type)
  return (
    <div className="node" style={{ '--accent': CATEGORY_COLOR[type.category] ?? '#64748b' } as React.CSSProperties}>
      {type.hasInput !== false && <span className="handle handle--in" />}
      <div className="node__head">
        <span className="node__icon">{type.icon}</span>
        <div className="node__titles">
          <div className="node__name">{type.name}</div>
          <div className="node__summary">{type.description}</div>
        </div>
      </div>
      {ports.length === 1 && ports[0].id === 'out' && <span className="handle handle--out" />}
      {ports.length > 1 && (
        <div className="node__ports">
          {ports.map((p) => (
            <div className="node__port" key={p.id}>
              <span>{p.label}</span>
              <span className="handle handle--port" />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
