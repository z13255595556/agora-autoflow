import type { JsonSchema } from '../types'

/** 找出一条节点校验错误对应的 schema 字段；流程结构错误返回 null。 */
export function validationFieldKey(error: string, schema: JsonSchema): string | null {
  const properties = schema.properties ?? {}
  const requiredTitle = error.match(/^必填项「([^」]+)」未填$/)?.[1]
  if (requiredTitle) {
    return Object.entries(properties).find(([key, sub]) => key === requiredTitle || sub.title === requiredTitle)?.[0] ?? null
  }

  const explicitKey = error.match(/^「([^」]+)」/)?.[1]
  if (explicitKey && properties[explicitKey]) return explicitKey

  // SQL 占位符缺值时，可修复的位置是由 x-placeholders 指向的参数字段。
  if (error.startsWith('占位符 ')) {
    for (const sub of Object.values(properties)) {
      const target = sub['x-placeholders']?.valuesFrom
      if (target && properties[target]) return target
    }
  }

  // 专用节点校验有时直接引用字段标题，优先定位命中的具体字段。
  return Object.entries(properties).find(([, sub]) => !!sub.title && error.includes(`「${sub.title}」`))?.[0] ?? null
}

/** 滚动并聚焦 Inspector 里的具体字段。 */
export function focusValidationField(error: string, schema: JsonSchema): boolean {
  const key = validationFieldKey(error, schema)
  if (!key) return false
  const focus = () => {
    const field = [...document.querySelectorAll<HTMLElement>('.dock[data-node-id] [data-field-key]')]
      .find((element) => element.dataset.fieldKey === key)
    if (!field) return false
    field.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const control = field.querySelector<HTMLElement>('input:not([type="hidden"]), textarea, select, button')
    control?.focus({ preventScroll: true })
    field.classList.remove('field--attention')
    void field.offsetWidth
    field.classList.add('field--attention')
    window.setTimeout(() => field.classList.remove('field--attention'), 1100)
    return true
  }
  if (focus()) return true

  const tab = [...document.querySelectorAll<HTMLButtonElement>('.dock .httpform button[data-field-keys]')]
    .find((button) => button.dataset.fieldKeys?.split(' ').includes(key))
  if (!tab || tab.disabled) return false
  tab.click()
  window.setTimeout(focus, 0)
  return true
}
