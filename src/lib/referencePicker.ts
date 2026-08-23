import type { JsonType } from './outputShape.ts'

/**
 * 取值面板的一次请求。
 *
 * `owner` 是**发起的那个字段**的实例 id。面板挂在应用根上（`ReferencePickerProvider`），
 * 字段挂在节点侧栏 / NDV / 条件行里 —— 两者生命周期不一样：关掉节点编辑侧栏、
 * 换选中的节点、双击打开 NDV，字段都会被卸掉，而面板还留在原地。留下来的不只是
 * 视觉问题：`.dataref` 是 `right: 424px`，正对着已经消失的那一栏，而且里面每个候选项
 * 点下去只会调到一个已卸载组件的 `replace`，值悄悄丢掉。
 *
 * 所以每次请求都记下是谁开的，字段卸载时按 owner 收起。
 */
export interface ReferenceTarget {
  owner: string
  nodeId: string
  query: string
  mixed: boolean
  expectedType?: JsonType
  initialExpression?: string
  replace: (snippet: string) => void
}

/**
 * 卸载的字段只收起**自己**开的那一次。
 *
 * 不看 owner 直接清空的话，任何一次"先开后卸"都会误关：同一次提交里 React 先跑卸载
 * 的清理再跑新挂载的效果，条件行里 `VariableField` 和它内部的 `RefField` 又是两个
 * owner —— 只卸掉其中一个时，面板不该跟着走。
 */
export function closeOwned(current: ReferenceTarget | null, owner: string): ReferenceTarget | null {
  return current && current.owner === owner ? null : current
}
