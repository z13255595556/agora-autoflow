import type { ExpectedType } from './referenceFit.ts'

/**
 * 取值面板的一次请求。
 *
 * `owner` 是**发起的那个字段**的实例 id。取值栏现在长在编辑器卡片里（侧栏是左边
 * 那一栏，NDV 是「参数」左边那一栏），但请求本身仍然存在 provider 上 —— 字段挂在
 * 节点侧栏 / NDV / 条件行里，生命周期比请求短：换选中的节点、双击打开 NDV，字段都会
 * 被卸掉。留着一个没主的请求，抽屉会对着一栏已经不存在的东西开着，而且里面每个
 * 候选项点下去只会调到一个已卸载组件的 `replace`，值悄悄丢掉。
 *
 * 所以每次请求都记下是谁开的，字段卸载时按 owner 收起。
 */
export interface ReferenceTarget {
  owner: string
  nodeId: string
  /** 正在填的那个字段叫什么。取值栏顶上要写「为「内容」」，把两栏拴在一起 */
  fieldLabel?: string
  query: string
  mixed: boolean
  expectedType?: ExpectedType
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
