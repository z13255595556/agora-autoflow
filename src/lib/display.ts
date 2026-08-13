import type { JsonSchema } from '../types'

/**
 * 条件显示求值（对齐 n8n node-helpers.ts displayParameter 的实测语义）：
 * - show：多个 key 之间 AND（全部命中才显示），每个 key 的候选值数组内 OR
 * - hide：多个 key 之间 OR（任一命中即隐藏），且在 show 之后判定、优先生效
 * - 被引用参数未填时回退到它的 default 参与比较
 *   （n8n 用 returnDefaults 的 nodeValuesDisplayCheck 做同样的事）
 */
export function isFieldVisible(
  key: string,
  schema: JsonSchema,
  params: Record<string, unknown>,
): boolean {
  const prop = schema.properties?.[key]
  if (!prop) return true

  // n8n 只对「未设置」的参数代入 default，用户显式清空成 '' 不代入
  const valueOf = (name: string): unknown =>
    params[name] !== undefined ? params[name] : schema.properties?.[name]?.default

  const keyMatches = (name: string, allowed: Array<string | number | boolean>): boolean => {
    const v = valueOf(name)
    return allowed.some((a) => a === v)
  }

  const show = prop['x-show']
  if (show && !Object.entries(show).every(([n, a]) => keyMatches(n, a))) return false
  const hide = prop['x-hide']
  if (hide && Object.entries(hide).some(([n, a]) => keyMatches(n, a))) return false
  return true
}

/** 当前参数组合下可见的字段 key 列表 */
export function visibleFields(schema: JsonSchema, params: Record<string, unknown>): string[] {
  return Object.keys(schema.properties ?? {}).filter((k) => isFieldVisible(k, schema, params))
}
