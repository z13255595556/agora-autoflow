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

/**
 * 参数表单可能在两个地方：右侧栏，或节点编辑页（NDV）的参数栏。
 * 两个不会同时挂着 —— NDV 一打开，App 就把 Inspector 卸了（见 App.tsx 的注释：
 * 同一个节点存在两棵表单会让变量弹窗飘到模态前面）—— 所以一次查询覆盖两处即可。
 * 漏掉 NDV 那半边的后果是静默的：编辑页里点运行被拦下来，却没有任何一格被点亮。
 */
const FORM_SCOPES = ['.dock[data-node-id]', '.ndv__col--params']
const scoped = (selector: string) => FORM_SCOPES.map((scope) => `${scope} ${selector}`).join(', ')

/** 滚动并聚焦参数表单里的具体字段。 */
export function focusValidationField(error: string, schema: JsonSchema): boolean {
  const key = validationFieldKey(error, schema)
  if (!key) return false
  const focus = () => {
    const field = [...document.querySelectorAll<HTMLElement>(scoped('[data-field-key]'))]
      .find((element) => element.dataset.fieldKey === key)
    if (!field) return false
    field.scrollIntoView({ block: 'center', behavior: 'smooth' })
    // contenteditable 要显式列出来：它既不是 input 也不是 textarea，漏掉的话
    // 选择器会往下命中字段里的第一个 <button>（取值面板的召唤按钮），
    // 「定位」看起来生效了，焦点却落在一个跟这条错误无关的东西上。
    const control = field.querySelector<HTMLElement>(
      'input:not([type="hidden"]), textarea, select, [contenteditable="true"], button',
    )
    control?.focus({ preventScroll: true })
    field.classList.remove('field--attention')
    void field.offsetWidth
    field.classList.add('field--attention')
    window.setTimeout(() => field.classList.remove('field--attention'), 1100)
    return true
  }
  if (focus()) return true

  const tab = [...document.querySelectorAll<HTMLButtonElement>(scoped('.httpform button[data-field-keys]'))]
    .find((button) => button.dataset.fieldKeys?.split(' ').includes(key))
  if (!tab || tab.disabled) return false
  tab.click()
  window.setTimeout(focus, 0)
  return true
}
