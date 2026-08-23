import type { JsonType } from './outputShape.ts'
import type { ReferenceSelection } from './referenceSelection.ts'

export function fitReason(
  selection: ReferenceSelection,
  expected?: JsonType | 'url' | 'message',
): string | null {
  if (!expected) return null
  if (expected === 'url' && (selection.mode === 'table' || selection.mode === 'all' || selection.valueType === 'object' || selection.valueType === 'array')) {
    return 'URL 只能插入单个文本值'
  }
  if (expected === 'message') return null
  if (expected === 'string') {
    if (selection.mode === 'table' || selection.valueType === 'object') {
      return '这个文本框需要一个值，请先选具体字段'
    }
    return null
  }
  if ((expected === 'integer' || expected === 'number') && selection.valueType !== 'integer' && selection.valueType !== 'number') {
    return '这里需要数字'
  }
  return null
}
