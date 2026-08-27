import { createContext, useCallback, useContext, useEffect, useId, useMemo, useState, type ReactNode } from 'react'
import { closeOwned, type ReferenceTarget } from '../lib/referencePicker'

export type { ReferenceTarget }

/**
 * 提供者对外只暴露动作，**不**带当前请求。
 *
 * 这个对象必须恒等：字段那边有个"卸载时收起自己"的效果，它的依赖里有这个对象。
 * 一旦它跟着 request 变，效果每敲一个字就重跑一次清理 —— 面板刚开就被自己关掉。
 * 当前 request 走**另一个** context，只有取值栏的宿主（节点侧栏 / NDV）订阅它。
 */
interface PickerActions {
  open: (target: ReferenceTarget) => void
  closeIfOwner: (owner: string) => void
  close: () => void
}

const ReferencePickerContext = createContext<PickerActions | null>(null)
const ReferenceRequestContext = createContext<ReferenceTarget | null>(null)

export function ReferencePickerProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<ReferenceTarget | null>(null)
  const open = useCallback((target: ReferenceTarget) => setRequest(target), [])
  const closeIfOwner = useCallback((owner: string) => setRequest((cur) => closeOwned(cur, owner)), [])
  const close = useCallback(() => setRequest(null), [])
  const actions = useMemo(() => ({ open, closeIfOwner, close }), [open, closeIfOwner, close])

  return (
    <ReferencePickerContext.Provider value={actions}>
      <ReferenceRequestContext.Provider value={request}>
        {children}
      </ReferenceRequestContext.Provider>
    </ReferencePickerContext.Provider>
  )
}

/**
 * 取值栏宿主拿的句柄。
 *
 * 取值栏不再挂在应用根上浮在所有东西前面 —— 它是编辑器卡片自己的一栏，
 * 所以由卡片（节点侧栏 / NDV）渲染，从这里取当前请求。
 */
export function useReferenceHost(nodeId: string): { request: ReferenceTarget | null; close: () => void } {
  const request = useContext(ReferenceRequestContext)
  const actions = useContext(ReferencePickerContext)
  const close = useCallback(() => actions?.close(), [actions])
  // 只认自己这个节点的请求：NDV 开着的时候侧栏是卸掉的，但两边都订阅同一个 context
  return { request: request && request.nodeId === nodeId ? request : null, close }
}

/** 字段拿到的句柄。`owner` 由 hook 自己补上，调用方不用管 */
export interface FieldPicker {
  open: (target: Omit<ReferenceTarget, 'owner'>) => void
  close: () => void
}

/**
 * 字段侧的取值面板句柄：open / close 都只作用于**自己**开的那一次，
 * 并且字段卸载时自动收起。
 *
 * 后一条是这个 hook 存在的理由。面板不在字段的 DOM 树里（它得盖住画布、
 * 宽度也不受侧栏限制），React 不会替我们收尾 —— 「打开节点编辑侧栏 → 输入 /
 * 弹出面板 → 关掉侧栏」以前会留下一个孤零零的面板，对着一栏已经不存在的空白。
 */
export function useReferencePicker(): FieldPicker | null {
  const actions = useContext(ReferencePickerContext)
  const owner = useId()
  const close = useCallback(() => actions?.closeIfOwner(owner), [actions, owner])
  // 依赖里两个值都恒等 → 这个清理只在字段真正卸载时跑一次
  useEffect(() => close, [close])
  return useMemo(
    () => (actions ? { open: (target) => actions.open({ ...target, owner }), close } : null),
    [actions, owner, close],
  )
}
