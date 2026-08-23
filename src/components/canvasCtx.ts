import { createContext, useContext } from 'react'

/**
 * 画布内部的"我要加个节点"请求。
 *
 * 节点卡片上的 `+`、连线中间的 `+`、左上角的「添加节点」按钮，三个入口都要弹
 * 同一个选择器，但它们分散在 react-flow 的自定义节点/连线组件里，拿不到 Canvas
 * 的 state。用 context 把入口和选择器接起来，比把 picker 状态塞进全局 store 干净
 * —— 那是纯 UI 的临时状态，不该混进流程数据里。
 */

export type PickTarget =
  /** 落在画布空白处（坐标是屏幕坐标，由 picker 换算） */
  | { kind: 'free' }
  | { kind: 'trigger' }
  /** 接在某个节点的某个出口后面 */
  | { kind: 'after'; nodeId: string; port: string }
  /** 从出口拖到空白画布后，在松手位置创建并连接节点 */
  | { kind: 'connection'; nodeId: string; port: string; dropAt: { x: number; y: number } }
  /** 插进某条连线中间 */
  | { kind: 'edge'; edgeId: string }

export interface PickerRequest {
  /** 弹出位置（屏幕坐标），一般是触发按钮的中心 */
  anchor: { x: number; y: number }
  target: PickTarget
}

export const CanvasCtx = createContext<{ openPicker: (req: PickerRequest) => void }>({
  openPicker: () => {},
})

export const useCanvasCtx = () => useContext(CanvasCtx)

/** 从一个 DOM 元素算出弹出锚点 —— 三个入口都靠它，省得各自量一遍 */
export function anchorOf(el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect()
  return { x: r.left + r.width / 2, y: r.bottom }
}
