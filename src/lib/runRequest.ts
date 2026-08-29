import type { FlowInputField } from '../types.ts'

export type RunRequest =
  | { action: 'start'; trigger: Record<string, unknown> }
  | { action: 'open-panel'; reason: 'missing-inputs' | 'invalid'; messages: string[] }
  | { action: 'stop' }

/**
 * 表单里的一格文本 → 入参的真实值。**按种类转换只在这一处**：
 * 手动运行、单节点试运行、webhook 示例都走它，否则"表单显示日期、引擎当字符串"
 * 这种事会只在某一条路径上发生。
 */
export function coerceInput(field: FlowInputField, raw: string): unknown {
  switch (field.type) {
    case 'integer': return Number(raw || 0)
    case 'number': return Number(raw || 0)
    case 'boolean': return raw === 'true'
    // date / select / string 都是原样的字符串：日期是 yyyy-MM-dd，SQL 占位符直接能用
    default: return raw
  }
}

/** 表单初值：有默认值的项预填，没有的留空 */
export function defaultForm(flowInputs: FlowInputField[]): Record<string, string> {
  const out: Record<string, string> = {}
  for (const f of flowInputs) {
    if (f.default !== undefined && f.default !== '') out[f.key] = f.default
  }
  return out
}

export function triggerFromForm(
  flowInputs: FlowInputField[],
  form: Record<string, string>,
): Record<string, unknown> {
  const trigger: Record<string, unknown> = {}
  for (const field of flowInputs) {
    trigger[field.key] = coerceInput(field, form[field.key] ?? '')
  }
  return trigger
}

/**
 * 必填但表单里还空着的入参。整条运行和单节点试运行共用这一把尺子 ——
 * 两处判得不一样的话，会出现「顶栏拦住了、节点编辑页却放过去」的洞。
 */
export function missingRequiredInputs(
  flowInputs: FlowInputField[],
  form: Record<string, string>,
): FlowInputField[] {
  return flowInputs.filter((field) => field.required && !form[field.key]?.trim())
}

export function decideRunRequest(input: {
  running: boolean
  flowInputs: FlowInputField[]
  form: Record<string, string>
  problems: string[]
}): RunRequest {
  if (input.running) return { action: 'stop' }
  if (input.problems.length > 0) {
    return { action: 'open-panel', reason: 'invalid', messages: input.problems }
  }
  const missing = missingRequiredInputs(input.flowInputs, input.form)
  if (missing.length > 0) {
    return {
      action: 'open-panel',
      reason: 'missing-inputs',
      messages: missing.map((field) => field.title || field.key),
    }
  }
  return { action: 'start', trigger: triggerFromForm(input.flowInputs, input.form) }
}

/**
 * 单节点试运行按不按得下去；返回的每一条都是「按下去也白按」的理由，
 * 第一条直接摆在节点编辑页的运行条上。
 *
 * 和整条运行的 decideRunRequest 分开，因为两件事拦的东西不一样：
 * 单节点不看图结构（没接触发器、图上有孤岛，都不妨碍单独跑这一个节点），
 * 但**必填入参照样要拦** —— 试运行和整条运行读的是同一套 `$.trigger.*`
 * （store.testStep 会把手动表单的值拼进 trigger），入参空着跑出来的是一份
 * 「悄悄用了空日期」的结果：节点是绿的、输出有行、数字是错的，
 * 界面上没有任何迹象。
 *
 * 以前这道闸只装在底部运行面板的运行按钮上，而节点编辑页是**全屏模态、
 * 正好把那个面板整个盖住** —— 从编辑页进去试运行就绕过了它，
 * 而且本地往往复现不出来：本机 localStorage 里通常还留着上次填的入参。
 */
export function stepRunBlockers(input: {
  running: boolean
  /** validateNode 的结果：这个节点自己的参数错 */
  nodeErrors: string[]
  flowInputs: FlowInputField[]
  form: Record<string, string>
}): string[] {
  if (input.running) return ['正在运行中，等这次跑完']
  const blockers = [...input.nodeErrors]
  const missing = missingRequiredInputs(input.flowInputs, input.form)
  if (missing.length > 0) {
    blockers.push(`必填入参未填：${missing.map((field) => field.title || field.key).join('、')}`)
  }
  return blockers
}
