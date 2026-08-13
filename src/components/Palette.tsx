import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { useReactFlow } from '@xyflow/react'
import { CATEGORY_COLOR, CATEGORY_ORDER, NODE_TYPES, portsOf } from '../registry'
import { useFlow } from '../store'
import type { NodeType } from '../types'

/** 影子还没挂上来时的兜底尺寸，挂上之后按真实节点量 */
const NODE_W = 190
const NODE_H = 60
/** 超过这个距离才算拖拽，避免手抖就甩出一个节点 */
const DRAG_THRESHOLD = 4

/** 拖拽中的状态。放 ref 里 —— 每次 pointermove 都 setState 会把整个列表重渲一遍 */
interface DragState {
  type: NodeType
  pointerId: number
  startX: number
  startY: number
  started: boolean
  origin: HTMLElement // 指针捕获挂在这个元素上，移出面板也收得到事件
}

const canvasEl = () => document.querySelector<HTMLElement>('.canvas')

export default function Palette() {
  const [q, setQ] = useState('')
  const addNode = useFlow((s) => s.addNode)
  const registryVersion = useFlow((s) => s.registryVersion) // 后端注册表到了要重列
  const { screenToFlowPosition, getZoom } = useReactFlow()

  const drag = useRef<DragState | null>(null)
  const pos = useRef({ x: 0, y: 0 })
  const size = useRef({ w: NODE_W, h: NODE_H })
  const ghostRef = useRef<HTMLDivElement>(null)
  // 只有"拖起了什么"进 state：控制影子挂载，一次拖拽只重渲两次
  const [ghost, setGhost] = useState<NodeType | null>(null)

  const paint = (x: number, y: number) => {
    pos.current = { x, y }
    const el = ghostRef.current
    if (!el) return
    // 跟着画布缩放一起缩，否则缩小视图时拖着个巨大的框、松手却落下个小节点
    const z = getZoom()
    const { w, h } = size.current
    el.style.transform = `translate3d(${x - (w * z) / 2}px, ${y - (h * z) / 2}px, 0) scale(${z})`
  }

  // 影子是 setState 之后才挂上来的，挂上的那一帧要立刻量尺寸并摆到指针处，
  // 否则会在左上角闪一下。量真实高度是为了让预览的中心和落点的中心一致
  useLayoutEffect(() => {
    if (!ghost) return
    const box = ghostRef.current?.firstElementChild as HTMLElement | null
    if (box) size.current = { w: box.offsetWidth || NODE_W, h: box.offsetHeight || NODE_H }
    paint(pos.current.x, pos.current.y)
  }, [ghost])

  const end = useCallback(
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

      if (!d?.started || !drop) return
      const rect = canvasEl()?.getBoundingClientRect()
      if (!rect) return
      const inside =
        drop.x >= rect.left && drop.x <= rect.right && drop.y >= rect.top && drop.y <= rect.bottom
      if (!inside) return // 丢在面板上/画布外 —— 当作取消，不要偷偷塞个节点到角落
      const p = screenToFlowPosition(drop)
      // size 是未缩放的布局尺寸，和流程坐标同一套单位，直接减半即可
      addNode(d.type.type, { x: p.x - size.current.w / 2, y: p.y - size.current.h / 2 })
    },
    [addNode, screenToFlowPosition],
  )

  // 拖到一半按 Esc 取消
  useEffect(() => {
    if (!ghost) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') end()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [ghost, end])

  const onPointerDown = (e: React.PointerEvent, t: NodeType) => {
    if (e.button !== 0) return
    const origin = e.currentTarget as HTMLElement
    try {
      origin.setPointerCapture(e.pointerId)
    } catch {
      /* 指针已失效就退回冒泡路径，拖拽照常，只是移出面板可能丢事件 */
    }
    drag.current = {
      type: t,
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      started: false,
      origin,
    }
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
      !!rect &&
      e.clientX >= rect.left &&
      e.clientX <= rect.right &&
      e.clientY >= rect.top &&
      e.clientY <= rect.bottom
    canvasEl()?.classList.toggle('canvas--dropzone', over)
  }

  const onPointerUp = (e: React.PointerEvent) => {
    if (drag.current?.pointerId !== e.pointerId) return
    end({ x: e.clientX, y: e.clientY })
  }

  const grouped = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const hit = NODE_TYPES.filter(
      (t) =>
        !kw ||
        t.name.toLowerCase().includes(kw) ||
        t.type.toLowerCase().includes(kw) ||
        (t.description ?? '').toLowerCase().includes(kw),
    )
    return CATEGORY_ORDER.map((c) => ({ category: c, items: hit.filter((t) => t.category === c) })).filter(
      (g) => g.items.length > 0,
    )
  }, [q, registryVersion])

  return (
    <aside className="panel panel--left">
      <div className="panel__head">
        <span className="panel__title">节点</span>
        <span className="panel__hint">拖到画布上添加</span>
      </div>
      <div className="panel__search">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索节点…" />
      </div>
      <div className="panel__body">
        {grouped.map((g) => (
          <section className="palette__group" key={g.category}>
            <div className="palette__cat">
              <i style={{ background: CATEGORY_COLOR[g.category] }} />
              {g.category}
            </div>
            {g.items.map((t) => (
              <div
                key={t.type}
                className="palette__item"
                onPointerDown={(e) => onPointerDown(e, t)}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={() => end()}
                title={t.description}
              >
                <span className="palette__icon" style={{ color: CATEGORY_COLOR[t.category] }}>
                  {t.icon}
                </span>
                <div className="palette__meta">
                  <div className="palette__name">{t.name}</div>
                  <div className="palette__desc">{t.description}</div>
                </div>
              </div>
            ))}
          </section>
        ))}
        {grouped.length === 0 && <div className="empty">没有匹配的节点</div>}
      </div>
      <div className="panel__foot">{NODE_TYPES.length} 个节点 · 注册表由各服务上报</div>

      {ghost && (
        <div className="palette__ghost" ref={ghostRef}>
          <NodePreview type={ghost} />
        </div>
      )}
    </aside>
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
          {/* 真实节点这里会带 n3 之类的编号，还没落地就没有编号，只显示类型 */}
          <div className="node__type">{type.type}</div>
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
      {ports.length === 0 && <div className="node__terminal">终点</div>}
    </div>
  )
}
