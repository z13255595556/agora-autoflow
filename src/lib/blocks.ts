/**
 * `{{ }}` 的形状学：怎么切、切出来算哪一类、还能不能原样拼回去。
 *
 * **这个文件不许有任何相对导入。** 两个原因：
 *   1. 它是"块是什么形状"这件事的唯一住址。校验方（vars）、引擎（engine）、
 *      编辑器（RefField）都从这里取，谁都不许自己再写一遍正则 —— 分词器和
 *      引擎一旦对"什么算一个块"产生分歧，胶囊显示的东西和运行时解析的东西
 *      就不是一回事了，而且是静默的。
 *   2. 没有相对导入，`node --test --experimental-strip-types` 就能直接跑它，
 *      不用引入任何测试框架。
 */

export type BlockKind =
  /** 普通文本 */
  | 'text'
  /** 带 $. 的引用，可能还接了过滤器 */
  | 'ref'
  /** 函数调用，目前只有 date() */
  | 'fn'
  /** 裸标识符，透传给后端当 SQL 占位符 —— 只在声明了 x-placeholders 的字段里成立 */
  | 'placeholder'
  /** 字面量或字面量之间的比较 */
  | 'expr'
  /** 十有八九是写错了 */
  | 'bad'

export interface Block {
  kind: BlockKind
  /** 原文。**恒有 raw === value.slice(start, end)**，整个无损往返都架在这上面 */
  raw: string
  /** {{ }} 之间去掉首尾空白的内容；text 块为 '' */
  body: string
  start: number
  end: number
}

/**
 * 和 engine.resolveTemplate 逐字符相同的块正则。
 *
 * `[^}]*` 而不是贪婪的 `[\s\S]*`：否则 "{{ a }} 和 {{ b }}" 会被整体吞成一个块。
 * 副作用是 `{{ a } b }}` 谁都匹配不上 —— 保持纯文本，两边一致就不会出错。
 *
 * 返回**新实例**而不是共享常量：带 /g 的正则有 lastIndex，共享一个会让
 * 交替调用的两个地方互相踩。
 *
 * 写成函数声明而不是 const 箭头：这个模块被 vars / engine 这些互相有引用关系的
 * 文件共用，函数声明会提升，不会有 TDZ 的余地。
 */
export function blockRe(): RegExp {
  return /\{\{([^}]*)\}\}/g
}

/** 表达式里能直接调用的函数，形如 date('now-1d','yyyyMMdd') */
export const CALL_RE = /^([A-Za-z_][A-Za-z0-9_]*)\s*\((.*)\)$/s

/** 裸标识符 —— SQL 占位符的形状 */
const BARE_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

const LITERAL_RE = /^(-?\d+(\.\d+)?|true|false|null|(["']).*\3)$/

/**
 * 一个 {{ }} 块里没有任何 $. 引用，也不是纯字面量 —— 十有八九是写错了。
 *
 * 最典型的是把 SQL 占位符写成了 `{{date}}`：引擎会把裸标识符原样还回去，
 * SQL 变成 `where date = date`，恒真且全表扫，静默出错。
 */
export function isBrokenBlock(block: string): boolean {
  if (!block) return true
  if (block.includes('$.')) return false
  // 函数调用，比如 date('now-1d','yyyyMMdd')。参数对不对由运行/预览时报错，
  // 这里只负责别把它当成写错的引用
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(block.trim())) return false
  // 去掉比较运算符后逐个看操作数
  return block
    .split(/(?:===|!==|==|!=|>=|<=|>|<)/)
    .map((s) => s.trim())
    .some((s) => s !== '' && !LITERAL_RE.test(s))
}

export interface TokenizeOptions {
  /**
   * 这个字段认裸 `{{name}}` 为 SQL 占位符（声明了 x-placeholders）。
   *
   * 关掉时裸标识符会落到 bad 渲染成红色 —— 那正是想要的：在没有占位符语义的
   * 字段里写 {{date}}，引擎运行期会抛，不如编辑期就红给用户看。
   */
  placeholders?: boolean
  /**
   * 这个位置是不是宿主语言的"死区"（SQL 的字符串字面量 / 注释）。
   *
   * 死区里的裸标识符前后端都不会替换，它就是字面文本，不该画成任何胶囊 ——
   * 画成占位符是撒谎，画成 bad 更糟（在注释里报一个不存在的错）。所以这种块
   * 直接降级成 text，并入相邻文本。
   *
   * **只影响裸标识符。** 引号里的 `'{{ $.x }}'` 照样会被前端替换掉
   * （registry 的 SQL 模板正是这么写的），那仍然是货真价实的引用。
   */
  inert?: (start: number) => boolean
}

function classify(body: string, start: number, opts: TokenizeOptions): BlockKind {
  // 顺序照抄引擎的判定顺序，胶囊的颜色才能预告运行期的行为
  if (body.includes('$.')) return 'ref'
  if (CALL_RE.test(body)) return 'fn'
  if (BARE_NAME_RE.test(body)) {
    if (opts.inert?.(start)) return 'text'
    if (opts.placeholders) return 'placeholder'
  }
  if (isBrokenBlock(body)) return 'bad'
  return 'expr'
}

/**
 * 把一段值切成「文本 / 块」交替的序列。
 *
 * 首尾一定是 text 块（可能是空串），中间严格交替 —— 这样调用方渲染 DOM 时
 * 不用特判两端，也不会出现两个挨着的文本节点。
 */
export function tokenizeRefs(value: string, opts: TokenizeOptions = {}): Block[] {
  const raw: Block[] = []
  const re = blockRe()
  let cursor = 0
  let m: RegExpExecArray | null
  const pushText = (start: number, end: number) => {
    raw.push({ kind: 'text', raw: value.slice(start, end), body: '', start, end })
  }
  while ((m = re.exec(value)) !== null) {
    pushText(cursor, m.index)
    const end = m.index + m[0].length
    const body = m[1].trim()
    raw.push({ kind: classify(body, m.index, opts), raw: m[0], body, start: m.index, end })
    cursor = end
  }
  pushText(cursor, value.length)

  // 降级成 text 的块（死区里的裸标识符）会造成两个相邻文本块，合并掉，
  // 交替性靠这一步维持
  const out: Block[] = []
  for (const b of raw) {
    const prev = out.at(-1)
    if (b.kind === 'text' && prev?.kind === 'text') {
      out[out.length - 1] = { ...prev, raw: prev.raw + b.raw, end: b.end }
    } else {
      out.push(b)
    }
  }
  return out
}

/** 拼回原值。tokenizeRefs 的逆运算，恒等于输入。 */
export const serializeBlocks = (blocks: Block[]): string => blocks.map((b) => b.raw).join('')

/** 零宽空格。胶囊两侧的守卫字符，序列化时全局剥除 —— 见 canChipify。 */
export const ZWSP = '​'

/** 再大就不值得为它重建几百个 DOM 节点了 */
const MAX_CHIP_LENGTH = 20_000

/**
 * 这个值能不能安全地进胶囊模式。
 *
 * 最后那行自检是忘不掉的兜底：分词器哪天复现不出某个值，那个字段就静默退回
 * 朴素 textarea，值不会被我们碰坏。
 *
 * 拒绝本来就含零宽空格的值，是为了让"序列化时剥除 ZWSP"这件事**可证明安全**
 * —— DOM 里出现 ZWSP 只可能是我们放的，不可能是用户的数据。
 */
export function canChipify(value: string, opts: TokenizeOptions = {}): boolean {
  if (value.length > MAX_CHIP_LENGTH) return false
  if (value.includes(ZWSP)) return false
  return serializeBlocks(tokenizeRefs(value, opts)) === value
}
