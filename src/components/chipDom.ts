import type { Block } from '../lib/blocks'
import { ZWSP } from '../lib/blocks'

/**
 * 胶囊编辑器的 DOM 层。纯 DOM 操作，不认识 React。
 *
 * 宿主的不变式（renderTokens 建立，serializeDom 容错，其余函数依赖）：
 *
 *     [文本节点] [胶囊] [文本节点] [胶囊] [文本节点]
 *
 * 严格交替，首尾一定是文本节点，没有 <br> 没有 <div>（靠拦 Enter 和 paste 保证）。
 * 每枚胶囊两侧的文本节点里各塞一个零宽空格做守卫 —— 没有它，"胶囊前面"和
 * "胶囊后面"这两个光标位在部分引擎里点不进去。
 *
 * 代价是 U+200B 成了结构字符：序列化时全局剥除。这一步可证明安全，因为
 * canChipify 拒绝任何本来就含零宽空格的值 —— DOM 里出现它只可能是我们放的。
 */

const CHIP_ATTR = 'data-chip-raw'
const ZWSP_RE = /​/g

const isText = (n: Node): n is Text => n.nodeType === Node.TEXT_NODE
const chipRawOf = (n: Node): string | null =>
  n instanceof HTMLElement && n.hasAttribute(CHIP_ATTR) ? n.getAttribute(CHIP_ATTR)! : null

export interface ChipVisual {
  text: string
  tone: string
  title: string
}

/**
 * 按 token 重建宿主内容。
 *
 * **绝不用 innerHTML。** 块体里可能有换行（`[^}]*` 匹配换行），dataset 能原样
 * 存住，innerHTML 重新解析会把它归一成空格 —— 那就是静默改了用户的值。
 */
export function renderTokens(host: HTMLElement, blocks: Block[], visual: (b: Block) => ChipVisual): void {
  const frag = document.createDocumentFragment()
  blocks.forEach((b, i) => {
    if (b.kind === 'text') {
      // 相邻是胶囊就补守卫。blocks 严格交替，所以"不是第一个"就等于"前面是胶囊"
      const lead = i > 0 ? ZWSP : ''
      const tail = i < blocks.length - 1 ? ZWSP : ''
      frag.appendChild(document.createTextNode(lead + b.raw + tail))
      return
    }
    const v = visual(b)
    const span = document.createElement('span')
    // rchip 而不是 chip：.chip 已经被顶栏的状态胶囊占了
    span.className = `rchip rchip--${v.tone}`
    span.setAttribute(CHIP_ATTR, b.raw)
    span.contentEditable = 'false'
    span.title = v.title
    // 读屏念的是表达式本身，不是我们编的漂亮名字
    span.setAttribute('aria-label', b.raw)
    span.textContent = v.text
    frag.appendChild(span)
  })
  host.replaceChildren(frag)
}

/**
 * 宿主 DOM → 字符串。
 *
 * 必须是全函数：自动更正、emoji 面板、拖放都可能塞进我们没建的节点。遇到
 * 不认识的元素就递归它的子节点，块级元素前补一个换行 —— 宁可结构还原得糙一点，
 * 也不能丢字符。
 */
export function serializeDom(host: HTMLElement): string {
  let out = ''
  const walk = (node: Node) => {
    if (isText(node)) {
      out += node.data.replace(ZWSP_RE, '')
      return
    }
    if (node.nodeName === 'BR') {
      out += '\n'
      return
    }
    const raw = chipRawOf(node)
    if (raw !== null) {
      out += raw
      return
    }
    if (node instanceof HTMLElement && isBlockish(node) && out && !out.endsWith('\n')) out += '\n'
    node.childNodes.forEach(walk)
  }
  host.childNodes.forEach(walk)
  return out
}

const isBlockish = (el: HTMLElement) => {
  const d = getComputedStyle(el).display
  return d === 'block' || d === 'list-item' || d.startsWith('table')
}

/** 宿主里有我们没建的节点 —— 该安排一次结构性重建了（但不能在合成期间） */
export function hasForeignNodes(host: HTMLElement): boolean {
  return [...host.childNodes].some((n) => !isText(n) && chipRawOf(n) === null)
}

export interface CaretInfo {
  /** 光标在序列化字符串里的下标 */
  offset: number
  /**
   * 光标所在文本节点的起点在字符串里的下标。
   *
   * slash 匹配靠它兜底：`slashMatchAt` 是在序列化串上往回扫的，而串里含胶囊
   * 原文。胶囊里的 `/`（比如 `date('now-1d','yyyy/MM')`）会让匹配的起点落到
   * 胶囊内部，替换的时候就把胶囊撕碎了。有了 floor 就能把这种匹配直接扔掉。
   */
  floor: number
}

/** 当前选区的折叠光标位置。没有选区 / 不在宿主里返回 null。 */
export function caretInfo(host: HTMLElement): CaretInfo | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const range = sel.getRangeAt(0)
  if (!host.contains(range.startContainer)) return null
  return domToStringOffset(host, range.startContainer, range.startOffset)
}

export function domToStringOffset(host: HTMLElement, container: Node, containerOffset: number): CaretInfo {
  let acc = 0
  // 光标落在宿主本身时，containerOffset 是子节点下标
  if (container === host) {
    for (let i = 0; i < containerOffset && i < host.childNodes.length; i++) {
      acc += lengthOf(host.childNodes[i])
    }
    // Chromium may place a collapsed caret on the host boundary immediately after a
    // text node instead of inside that text node. In that representation the slash
    // query is still allowed to start in the preceding text; after a chip it is not.
    const previous = containerOffset > 0 ? host.childNodes[containerOffset - 1] : null
    const floor = previous && isText(previous) ? acc - lengthOf(previous) : acc
    return { offset: acc, floor }
  }
  for (const child of host.childNodes) {
    if (child === container || child.contains(container)) {
      if (isText(child)) {
        const before = child.data.slice(0, containerOffset).replace(ZWSP_RE, '').length
        return { offset: acc + before, floor: acc }
      }
      // 落在胶囊里（框选拖进去了）：夹到最近的边界，胶囊内部没有光标位
      const raw = chipRawOf(child) ?? ''
      return containerOffset === 0 ? { offset: acc, floor: acc } : { offset: acc + raw.length, floor: acc + raw.length }
    }
    acc += lengthOf(child)
  }
  return { offset: acc, floor: acc }
}

function lengthOf(node: Node): number {
  if (isText(node)) return node.data.replace(ZWSP_RE, '').length
  const raw = chipRawOf(node)
  if (raw !== null) return raw.length
  return (node.textContent ?? '').replace(ZWSP_RE, '').length
}

/** 把字符串下标放回 DOM。落在胶囊原文中间的下标夹到就近的边界。 */
export function setCaret(host: HTMLElement, index: number): void {
  let acc = 0
  for (const child of host.childNodes) {
    const len = lengthOf(child)
    if (isText(child) && index <= acc + len) {
      placeCaret(child, domOffsetFor(child, index - acc))
      return
    }
    if (!isText(child) && index > acc && index < acc + len) {
      // 胶囊内部 —— 夹到后边界
      placeCaret(child, 1)
      return
    }
    acc += len
  }
  const last = host.lastChild
  if (last && isText(last)) placeCaret(last, last.data.length)
  else placeCaretAfter(host)
}

/** 字符串下标 → 这个文本节点里的 DOM 下标，跳过守卫用的零宽空格 */
function domOffsetFor(node: Text, want: number): number {
  let seen = 0
  for (let i = 0; i < node.data.length; i++) {
    if (seen === want && node.data[i] !== ZWSP) return i
    if (node.data[i] !== ZWSP) seen += 1
  }
  return node.data.length
}

function placeCaret(node: Node, offset: number) {
  const range = document.createRange()
  range.setStart(node, offset)
  range.collapse(true)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

function placeCaretAfter(host: HTMLElement) {
  const range = document.createRange()
  range.selectNodeContents(host)
  range.collapse(false)
  const sel = document.getSelection()
  sel?.removeAllRanges()
  sel?.addRange(range)
}

/**
 * 折叠光标紧挨着的那枚胶囊。
 *
 * 「紧挨着」要跳过守卫零宽空格 —— 光标停在 `​` 之后时，视觉上它就贴着
 * 胶囊，退格该整枚删掉。
 */
export function adjacentChip(host: HTMLElement, dir: 'before' | 'after'): HTMLElement | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return null
  const range = sel.getRangeAt(0)
  const { startContainer: node, startOffset } = range
  if (!host.contains(node)) return null
  if (!isText(node)) return null

  if (dir === 'before') {
    // 光标前面除了守卫没有别的字符，才算贴着前一枚胶囊
    if (node.data.slice(0, startOffset).replace(ZWSP_RE, '') !== '') return null
    const prev = node.previousSibling
    return prev && chipRawOf(prev) !== null ? (prev as HTMLElement) : null
  }
  if (node.data.slice(startOffset).replace(ZWSP_RE, '') !== '') return null
  const next = node.nextSibling
  return next && chipRawOf(next) !== null ? (next as HTMLElement) : null
}

/** 某枚胶囊在字符串里占的区间 */
export function chipRange(host: HTMLElement, chip: Node): { start: number; end: number } | null {
  let acc = 0
  for (const child of host.childNodes) {
    const len = lengthOf(child)
    if (child === chip) return { start: acc, end: acc + len }
    acc += len
  }
  return null
}

/** 判断序列化偏移是否真的落在胶囊原文内，避免依赖浏览器不稳定的 Selection 边界。 */
export function offsetInsideChip(host: HTMLElement, offset: number): boolean {
  for (const chip of host.querySelectorAll<HTMLElement>(`[${CHIP_ATTR}]`)) {
    const span = chipRange(host, chip)
    if (span && offset >= span.start && offset < span.end) return true
  }
  return false
}

/** 当前选区在字符串里的区间。折叠选区 start === end。 */
export function selectionRange(host: HTMLElement): { start: number; end: number } | null {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0) return null
  const r = sel.getRangeAt(0)
  if (!host.contains(r.startContainer) || !host.contains(r.endContainer)) return null
  const a = domToStringOffset(host, r.startContainer, r.startOffset).offset
  const b = domToStringOffset(host, r.endContainer, r.endOffset).offset
  return { start: Math.min(a, b), end: Math.max(a, b) }
}

/** 选区序列化成纯文本。复制胶囊必须给出原始表达式，不是它的漂亮名字。 */
export function serializeSelection(): string {
  const sel = document.getSelection()
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return ''
  const holder = document.createElement('div')
  holder.appendChild(sel.getRangeAt(0).cloneContents())
  // cloneContents 会把整枚胶囊连同 data-chip-raw 一起带过来，serializeDom 认得
  return serializeDom(holder)
}
