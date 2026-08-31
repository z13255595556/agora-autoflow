import type { JsonType } from './outputShape.ts'
import type { ReferenceSelection } from './referenceSelection.ts'

/**
 * 插入目标的「形状」，决定取值面板放行哪些选择。
 *
 * 按**单行 / 多行**分，不按节点分：企微正文、结束节点的结果、文本转换的模板
 * 都是「文字里混多个变量」的多行场景，表格（markdown 字符串）在哪个里都成立；
 * 而请求头、URL 参数、@成员这类单行字段，塞进带换行的表格会直接把值撑破
 * （HTTP 头里带 \n 是运行期才炸的错）。
 *
 * 这里只管「形状合不合适」。「msgtype 渲染不渲染表格」不在插入期拦 ——
 * 插完再改 msgtype 这里根本看不见，拦了也白拦；那件事由 MessagePreview 的
 * needsV2 提醒负责（它实时读 msgtype）。曾有过一个全放行的 'message' 档位，
 * 从来没被任何字段传过（SchemaForm 一律传 'string'），结果是「表格」按钮
 * 在整个应用里没有一个文本框能收 —— 死档位比没有档位更糟，已删。
 */
export type ExpectedType = JsonType | 'url' | 'text'

/**
 * 「表格」页签和「取前 N 行 + 作为表格」编译出来的都是 `| table(...)`，
 * 多行 markdown。判其一漏其一，等于规则只对一半的入口生效。
 */
const rendersAsTable = (selection: ReferenceSelection): boolean =>
  selection.mode === 'table' || (selection.mode === 'top' && (selection.columns?.length ?? 0) > 0)

export function fitReason(
  selection: ReferenceSelection,
  expected?: ExpectedType,
): string | null {
  if (!expected) return null
  if (expected === 'url') {
    if (rendersAsTable(selection) || selection.mode === 'all' || selection.valueType === 'object' || selection.valueType === 'array') {
      return 'URL 只能插入单个文本值'
    }
    return null
  }
  if (expected === 'string') {
    if (rendersAsTable(selection)) {
      return '这是单行文本，放不下多行的表格 —— 改选具体字段或用顿号拼接'
    }
    if (selection.valueType === 'object') {
      return '这个文本框需要一个值，请先选具体字段'
    }
    return null
  }
  if (expected === 'text') {
    // 多行文本收一切字符串产物（表格、拼接、单值）。整个对象塞进正文只会
    // 渲染成一坨 JSON，仍然要求先选字段；数组的混排问题由取值面板的
    // mixed 检查负责（独占整个字段时是合法的，比如 HTTP body 整体引用）。
    if (selection.valueType === 'object') {
      return '这个文本框需要一个值，请先选具体字段'
    }
    return null
  }
  if ((expected === 'integer' || expected === 'number') && selection.valueType !== 'integer' && selection.valueType !== 'number') {
    return '这里需要数字'
  }
  return null
}
