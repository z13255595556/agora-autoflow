import type { CSSProperties } from 'react'

/**
 * 光标定位。
 *
 * 拆成"量光标矩形"和"由矩形算样式"两步：矩形的量法和宿主类型有关
 * （input/textarea 只能靠镜像 div 反推，contenteditable 直接问 Range 就行），
 * 而翻转/夹取的数学两边一模一样，不该抄第二遍。
 */

export type TextEl = HTMLInputElement | HTMLTextAreaElement

/** .varpicker 的宽度 330 + 8 的边距。弹窗不能被推出右边缘。 */
const POPUP_W = 338
/** 下方至少留得出这么高才往下开，否则翻到光标上方 */
const POPUP_H = 240

export function popupStyleFromRect(rect: DOMRect, lineHeight: number): CSSProperties {
  const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPUP_W))
  if (rect.top + lineHeight + POPUP_H < window.innerHeight) {
    return { left, top: rect.top + lineHeight + 4 }
  }
  return { left, bottom: Math.max(8, window.innerHeight - rect.top + 4) }
}

/**
 * input / textarea 的光标矩形：拿一个隐藏镜像 div 重排一遍前缀文本反推出来。
 *
 * 原生控件不暴露光标坐标，只能这么量。复制的样式属性少一个都会让镜像的换行位置
 * 和真控件对不上，光标越靠后偏得越多。
 */
export function caretRectOfTextEl(el: TextEl, caret: number): DOMRect {
  const rect = el.getBoundingClientRect()
  const computed = getComputedStyle(el)
  const mirror = document.createElement('div')
  const marker = document.createElement('span')
  const props = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing', 'lineHeight',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft',
    'borderTopWidth', 'borderRightWidth', 'borderBottomWidth', 'borderLeftWidth',
  ] as const
  mirror.style.position = 'fixed'
  mirror.style.left = '-10000px'
  mirror.style.top = '0'
  mirror.style.visibility = 'hidden'
  mirror.style.boxSizing = 'border-box'
  mirror.style.width = `${rect.width}px`
  mirror.style.whiteSpace = el instanceof HTMLTextAreaElement ? 'pre-wrap' : 'pre'
  mirror.style.overflowWrap = 'break-word'
  for (const prop of props) mirror.style[prop] = computed[prop]
  mirror.textContent = el.value.slice(0, caret)
  marker.textContent = '​'
  mirror.appendChild(marker)
  document.body.appendChild(mirror)

  const caretLeft = rect.left + marker.offsetLeft - el.scrollLeft
  const caretTop = rect.top + marker.offsetTop - el.scrollTop
  mirror.remove()

  return new DOMRect(caretLeft, caretTop, 0, lineHeightOf(el))
}

/**
 * contenteditable 的光标矩形。
 *
 * 折叠 Range 在部分引擎返回全零矩形 —— 依次退到 getClientRects()[0]、
 * 往前扩一个字符的克隆 Range 的右边缘、宿主本身。
 */
export function caretRectOfRange(range: Range, host: HTMLElement): DOMRect {
  const direct = range.getBoundingClientRect()
  if (direct.top || direct.left) return direct

  const first = range.getClientRects()[0]
  if (first) return first

  if (range.startOffset > 0 && range.startContainer.nodeType === Node.TEXT_NODE) {
    const probe = range.cloneRange()
    probe.setStart(range.startContainer, range.startOffset - 1)
    const r = probe.getBoundingClientRect()
    if (r.top || r.left) return new DOMRect(r.right, r.top, 0, r.height)
  }
  return host.getBoundingClientRect()
}

/** computed lineHeight 可能是 'normal'，那时候拿不到数字，退回 20。 */
export function lineHeightOf(el: Element): number {
  return Number.parseFloat(getComputedStyle(el).lineHeight) || 20
}

/** 光标处的弹窗样式（原生 input / textarea 用） */
export function caretPopupStyle(el: TextEl, caret: number): CSSProperties {
  return popupStyleFromRect(caretRectOfTextEl(el, caret), lineHeightOf(el))
}
