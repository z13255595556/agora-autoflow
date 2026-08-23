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
  const missing = input.flowInputs.filter((field) => field.required && !input.form[field.key]?.trim())
  if (missing.length > 0) {
    return {
      action: 'open-panel',
      reason: 'missing-inputs',
      messages: missing.map((field) => field.title || field.key),
    }
  }
  return { action: 'start', trigger: triggerFromForm(input.flowInputs, input.form) }
}
