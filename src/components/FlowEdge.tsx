import { useState } from 'react'
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react'
import { useFlow } from '../store'
import { anchorOf, useCanvasCtx } from './canvasCtx'

/**
 * 连线。两件事是内置连线给不了的：
 *
 * 1. 悬停时中间冒出一个 `+`，点了就把节点插进这条线中间。
 *    没有它，"在两个节点之间加一步"要先删线、加节点、连两次线。
 * 2. 悬停时冒出 `×` 删除。1.6px 的线要精确点中再按 Delete，本身就是个难题。
 *
 * 运行后的条数标签走 data.count —— 自定义连线拿不到内置的 label 属性。
 */
export default function FlowEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  selected,
}: EdgeProps) {
  const [hover, setHover] = useState(false)
  const { openPicker } = useCanvasCtx()
  // 连线由 zustand 托管（受控模式），删除必须走 store 的 onEdgesChange，
  // 用 useReactFlow().setEdges 只会改 react-flow 的内部副本，下一帧就被 props 盖回来
  const onEdgesChange = useFlow((s) => s.onEdgesChange)
  const count = (data as { count?: string } | undefined)?.count

  const [path, labelX, labelY] = getBezierPath({
    sourceX,
    sourceY,
    sourcePosition,
    targetX,
    targetY,
    targetPosition,
    curvature: 0.35,
  })

  return (
    <>
      <BaseEdge id={id} path={path} className={hover || selected ? 'is-active' : undefined} />
      {/* 看不见的粗线，只为把悬停判定区放大到能用的宽度 */}
      <path
        d={path}
        className="edge__hit"
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
      />
      <EdgeLabelRenderer>
        <div
          className={`edgetools${hover ? ' is-hover' : ''}`}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={() => setHover(true)}
          onMouseLeave={() => setHover(false)}
        >
          {hover ? (
            <>
              <button
                className="edgebtn"
                title="在这里插入一个节点"
                onClick={(e) => {
                  e.stopPropagation()
                  openPicker({ anchor: anchorOf(e.currentTarget), target: { kind: 'edge', edgeId: id } })
                }}
              >
                +
              </button>
              <button
                className="edgebtn edgebtn--danger"
                title="删除这条连线"
                onClick={(e) => {
                  e.stopPropagation()
                  onEdgesChange([{ id, type: 'remove' }])
                }}
              >
                ✕
              </button>
            </>
          ) : (
            count && <span className="edgecount">{count}</span>
          )}
        </div>
      </EdgeLabelRenderer>
    </>
  )
}
