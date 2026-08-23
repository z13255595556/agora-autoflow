import type { ChangeEvent, ClipboardEvent, KeyboardEvent, MouseEvent } from 'react'
import { forwardRef, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from 'react'
import type { VarEntry } from '../lib/vars'
import { canChipify, tokenizeRefs, type TokenizeOptions } from '../lib/blocks'
import { describeBlock, type LabelCtx } from '../lib/refLabel'
import { sqlInertAt } from '../lib/placeholders'
import { slashMatchAt } from '../lib/slash'
import type { JsonType } from '../lib/outputShape'
import type { TextEl } from '../lib/caret'
import {
  adjacentChip, caretInfo, chipClickIntent, chipRange, expandChip, hasForeignNodes, renderTokens,
  offsetInsideChip, selectionRange, serializeDom, serializeSelection, setCaret,
} from './chipDom'
import { useReferencePicker } from './ReferencePickerContext'

/**
 * 能写 {{ }} 引用的输入框。两种形态，同一套对外契约。
 *
 * **朴素模式**：就是原来的 input / textarea。
 *
 * **胶囊模式**：contenteditable，`{{ … }}` 缩成一枚原子胶囊「SQL查询·avg_dc·第1行」，
 * 整体删除。用户不用再读也不用再写 `$.` 路径。
 *
 * 在它出现之前，「打 / 弹变量选择器 + 在光标处插一段」这套逻辑在 SchemaForm 里
 * 写了三遍，而且已经漂移了 —— 键值对表那份根本没有 ref，选完变量光标直接跳到
 * 末尾。收成一个组件之后，"没有 ref 的代码路径"这件事从构造上就不存在了。
 *
 * 插入通道做成命令式句柄而不是回调：取值面板挂在字段**外面**，它要往光标处
 * 插东西，就得能点名找到某一个字段实例。
 */

/**
 * 总开关。出问题的人在控制台敲一行就能退回朴素输入框，不用重新发版。
 * 三层降级里最外面那层，里面两层是 x-ui.expr === false 和 canChipify 自检。
 */
const CHIPS_ON = (() => {
  try {
    return localStorage.getItem('autoflow.chips') !== 'off'
  } catch {
    return true
  }
})()

/** 撤销快照的合并窗口。和 store.ts 的 HISTORY_GROUP_MS 取同一个数，两级撤销手感一致 */
const UNDO_GROUP_MS = 800
const UNDO_MAX = 50

export interface RefFieldHandle {
  /** 在光标处插入一段文本；没聚焦过就追加到末尾 */
  insert(snippet: string): void
  focus(): void
}

export interface RefFieldProps {
  value: string
  onChange: (next: string) => void
  /** 可选的变量，喂给 / 选择器 */
  vars: VarEntry[]
  multiline?: boolean
  rows?: number
  /** 等宽字体：SQL / JSON / CEL 这类 */
  mono?: boolean
  /** 密码框。contenteditable 无法遮蔽，所以这类字段永远是朴素 input */
  secret?: boolean
  /** 这个字段认裸 {{name}} 为 SQL 占位符 */
  placeholders?: boolean
  /** 开胶囊模式（还要过 CHIPS_ON 和 canChipify 两道） */
  chip?: boolean
  /** 胶囊文案要用的上下文；不给就不开胶囊 */
  labelCtx?: LabelCtx
  placeholder?: string
  className?: string
  ariaLabel?: string
  ariaInvalid?: boolean
  autoComplete?: string
  /** 当前字段所属节点，供右侧数据选择器过滤上游并回填。 */
  nodeId?: string
  expectedType?: JsonType
}

interface SlashState {
  start: number
  end: number
  query: string
}

const RefField = forwardRef<RefFieldHandle, RefFieldProps>(function RefField(props, ref) {
  const { value, secret, placeholders, chip, labelCtx } = props

  const tokenizeOpts = (v: string): TokenizeOptions => ({
    placeholders,
    // 声明了占位符的字段目前只有 SQL，死区判定就按 SQL 的来：注释和字符串
    // 字面量里的裸 {{name}} 前后端都不会替换，不该画成胶囊
    inert: placeholders ? sqlInertAt(v) : undefined,
  })

  const chipOn = Boolean(chip && labelCtx) && CHIPS_ON && !secret && canChipify(value, tokenizeOpts(value))

  return chipOn
    ? <ChipField {...props} ref={ref} labelCtx={labelCtx!} tokenizeOpts={tokenizeOpts} />
    : <PlainField {...props} ref={ref} />
})

export default RefField

// ------------------------------------------------------------------ 朴素模式

const PlainField = forwardRef<RefFieldHandle, RefFieldProps>(function PlainField(
  { value, onChange, multiline, rows, mono, secret, placeholder, className, ariaLabel, ariaInvalid, autoComplete, nodeId, expectedType },
  ref,
) {
  const elRef = useRef<TextEl | null>(null)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const slashActive = useRef(false)
  const picker = useReferencePicker()

  /** 替换 [start, end)，然后把光标放到插入内容之后 */
  const spliceAt = (start: number, end: number, snippet: string) => {
    onChange(value.slice(0, start) + snippet + value.slice(end))
    slashActive.current = false
    setSlash(null)
    const el = elRef.current
    if (!el) return
    // setTimeout 0：React 先把受控 value 写回去，直接设选区会被那次写入冲掉
    setTimeout(() => {
      el.focus()
      const pos = start + snippet.length
      el.setSelectionRange(pos, pos)
    }, 0)
  }

  useImperativeHandle(ref, () => ({
    insert(snippet: string) {
      const el = elRef.current
      if (!el) {
        onChange(value + snippet)
        slashActive.current = false
        setSlash(null)
        return
      }
      spliceAt(el.selectionStart ?? value.length, el.selectionEnd ?? el.selectionStart ?? value.length, snippet)
    },
    focus() {
      elRef.current?.focus()
    },
  }))

  const updateSlash = (el: TextEl, nextValue: string) => {
    if (secret) return
    const match = slashMatchAt(nextValue, el.selectionStart)
    if (!match) {
      if (slashActive.current) picker?.close()
      slashActive.current = false
      setSlash(null)
      return
    }
    slashActive.current = true
    setSlash(match)
    if (picker && nodeId) {
      picker.open({
        nodeId,
        query: match.query,
        mixed: (nextValue.slice(0, match.start) + nextValue.slice(match.end)).trim().length > 0,
        expectedType,
        replace: (snippet) => spliceAt(match.start, match.end, snippet),
      })
    }
  }

  const shared = {
    value,
    placeholder,
    'aria-label': ariaLabel,
    'aria-invalid': ariaInvalid,
    'aria-autocomplete': 'list' as const,
    'aria-expanded': slash !== null,
    onChange: (event: ChangeEvent<TextEl>) => {
      onChange(event.target.value)
      updateSlash(event.target, event.target.value)
    },
    onKeyDown: (event: KeyboardEvent<TextEl>) => {
      if (event.key === 'Escape' && slash) {
        picker?.close()
        slashActive.current = false
        setSlash(null)
      }
    },
    onClick: (event: MouseEvent<TextEl>) => updateSlash(event.currentTarget, event.currentTarget.value),
    // 150ms：点选择器里的项会先触发 blur，直接关掉就选不中了
    onBlur: () => setTimeout(() => setSlash(null), 150),
  }

  return (
    <>
      {multiline ? (
        <textarea
          {...shared}
          ref={(el) => { elRef.current = el }}
          className={[mono ? 'mono' : '', className ?? ''].filter(Boolean).join(' ') || undefined}
          rows={rows ?? 4}
          spellCheck={false}
        />
      ) : (
        <input
          {...shared}
          ref={(el) => { elRef.current = el }}
          className={className}
          type={secret ? 'password' : 'text'}
          autoComplete={autoComplete ?? (secret ? 'new-password' : undefined)}
        />
      )}
    </>
  )
})

// ------------------------------------------------------------------ 胶囊模式

interface ChipFieldProps extends RefFieldProps {
  labelCtx: LabelCtx
  tokenizeOpts: (v: string) => TokenizeOptions
}

const ChipField = forwardRef<RefFieldHandle, ChipFieldProps>(function ChipField(
  { value, onChange, multiline, rows, mono, placeholder, className, ariaLabel, ariaInvalid, labelCtx, tokenizeOpts, nodeId, expectedType },
  ref,
) {
  const hostRef = useRef<HTMLDivElement | null>(null)
  const [slash, setSlash] = useState<SlashState | null>(null)
  const slashActive = useRef(false)
  /** 结构性重建计数器。**不是** value —— 普通打字期间绝不重建 DOM，见下 */
  const [version, setVersion] = useState(0)
  const pendingCaret = useRef<number | null>(null)

  /**
   * 合成期间冻结一切。
   *
   * compositionupdate 每动一下都会重排候选词窗口，任何 DOM 写入都会让输入法把
   * 未上屏的字丢掉 —— 所以那个事件我们**刻意不监听**，别"顺手补一下"。
   */
  const composing = useRef(false)
  /** 我们最后一次向外发出的值。用来认出"这是我自己的回声"，避免自我重建 */
  const lastEmitted = useRef(value)
  const undo = useRef({ stack: [{ value, caret: value.length }], index: 0, at: 0 })
  const picker = useReferencePicker()
  /** 单击开取值面板要等一会儿，否则第二次 mousedown 到不了，双击展开会被吃掉 */
  const pickTimer = useRef<number | null>(null)

  useEffect(() => () => {
    if (pickTimer.current !== null) window.clearTimeout(pickTimer.current)
  }, [])

  // --- 结构性重建 -----------------------------------------------------------
  // 只在这些时刻发生：挂载、外部改值、显式插入、粘贴、删胶囊、失焦。
  // 普通打字不在其中 —— 一段连续输入里光标永远不被碰，这是整个输入法故事的前提。
  const bump = (caret: number | null) => {
    pendingCaret.current = caret
    setVersion((v) => v + 1)
  }

  useLayoutEffect(() => {
    const host = hostRef.current
    if (!host) return
    renderTokens(host, tokenizeRefs(value, tokenizeOpts(value)), (b) => {
      const l = describeBlock(b, labelCtx)
      return { text: l.text, tone: l.tone, title: `${l.title}\n双击编辑表达式` }
    })
    if (pendingCaret.current !== null) {
      setCaret(host, Math.min(pendingCaret.current, value.length))
      pendingCaret.current = null
    }
    // value 是在效果里现读的，故意不进依赖：进了就变成"每次改值都重建"
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [version])

  // 外部改了值（撤销、JSON 导入、别处写入）才重建；自己的回声跳过
  useEffect(() => {
    if (value === lastEmitted.current) return
    lastEmitted.current = value
    undo.current = { stack: [{ value, caret: value.length }], index: 0, at: 0 }
    bump(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value])

  // --- 出值 -----------------------------------------------------------------

  const pushUndo = (next: string, caret: number) => {
    const u = undo.current
    const now = Date.now()
    u.stack = u.stack.slice(0, u.index + 1)
    if (now - u.at < UNDO_GROUP_MS && u.stack.length > 1) u.stack[u.stack.length - 1] = { value: next, caret }
    else u.stack.push({ value: next, caret })
    if (u.stack.length > UNDO_MAX) u.stack.shift()
    u.index = u.stack.length - 1
    u.at = now
  }

  /** 幂等：compositionend 和尾随 input 的双触发因此无害，不必判断哪个浏览器发哪个 */
  const flush = () => {
    const host = hostRef.current
    if (!host || composing.current) return
    const next = serializeDom(host)
    // Some browser/input combinations briefly clear Selection during an input event even
    // though the editor remains focused. Treat that as an end-of-field caret so `/` still
    // opens the data drawer; mouse/key events will provide the exact caret on the next tick.
    const caret = caretInfo(host) ?? (document.activeElement === host
      ? { offset: next.length, floor: 0 }
      : null)
    if (next !== lastEmitted.current) {
      pushUndo(next, caret?.offset ?? next.length)
      lastEmitted.current = next
      onChange(next)
    }
    updateSlash(next, caret)
    // 自动更正 / emoji 面板 / 拖放可能塞进我们没建的节点，自愈一次
    if (hasForeignNodes(host)) bump(caret?.offset ?? null)
  }

  /** 改值 + 重建结构（插入、删胶囊、粘贴走这条） */
  const commit = (next: string, caret: number, recordUndo = true) => {
    if (recordUndo) pushUndo(next, caret)
    lastEmitted.current = next
    onChange(next)
    if (slashActive.current) picker?.close()
    slashActive.current = false
    setSlash(null)
    bump(caret)
  }

  // --- slash ----------------------------------------------------------------

  const updateSlash = (text: string, caret: ReturnType<typeof caretInfo>) => {
    if (!caret) {
      if (slashActive.current) picker?.close()
      slashActive.current = false
      return setSlash(null)
    }
    const match = slashMatchAt(text, caret.offset)
    // 胶囊里的 `/`（date('now-1d','yyyy/MM')）也会被正则扫到。
    // 直接按 DOM 胶囊区间拦截，不依赖浏览器不稳定的 Selection 边界表示。
    if (!match || offsetInsideChip(hostRef.current!, match.start)) {
      if (slashActive.current) picker?.close()
      slashActive.current = false
      return setSlash(null)
    }
    slashActive.current = true
    setSlash(match)
    if (picker && nodeId) {
      picker.open({
        nodeId,
        query: match.query,
        mixed: (text.slice(0, match.start) + text.slice(match.end)).trim().length > 0,
        expectedType,
        replace: (snippet) => commit(text.slice(0, match.start) + snippet + text.slice(match.end), match.start + snippet.length),
      })
    }
  }

  // --- 对外句柄 --------------------------------------------------------------

  useImperativeHandle(ref, () => ({
    insert(snippet: string) {
      const host = hostRef.current
      const at = (host && caretInfo(host)?.offset) ?? value.length
      commit(value.slice(0, at) + snippet + value.slice(at), at + snippet.length)
    },
    focus() {
      hostRef.current?.focus()
    },
  }))

  // --- 原生事件 --------------------------------------------------------------
  //
  // beforeinput 走原生监听而不是 React 的 onBeforeInput：后者在 React 里是
  // 合成事件，historyUndo / historyRedo 这两个 inputType 不保证透传。
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onBeforeInput = (e: Event) => {
      const t = (e as InputEvent).inputType
      if (t === 'historyUndo' || t === 'historyRedo') {
        // 原生撤销栈里存的是旧 DOM 形状。插入一枚胶囊就是一次结构性重写，
        // 撤回去序列化出来是垃圾 —— 而且是静默的垃圾。一刀切拦掉，自己维护。
        e.preventDefault()
        stepHistory(t === 'historyUndo' ? -1 : 1)
      }
    }
    host.addEventListener('beforeinput', onBeforeInput)
    return () => host.removeEventListener('beforeinput', onBeforeInput)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const stepHistory = (dir: -1 | 1) => {
    const u = undo.current
    const next = u.index + dir
    if (next < 0 || next >= u.stack.length) return
    u.index = next
    u.at = 0 // 撤销之后再打字要另起一帧，不能和撤销前的合并
    const snap = u.stack[next]
    commit(snap.value, snap.caret, false)
  }

  // --- 键盘 ------------------------------------------------------------------

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // 合成期间的 Enter / 方向键归输入法，一个都不能截
    if (event.nativeEvent.isComposing || event.keyCode === 229) return

    const host = hostRef.current
    if (!host) return

    const mod = event.metaKey || event.ctrlKey
    if (mod && event.key.toLowerCase() === 'z') {
      event.preventDefault()
      stepHistory(event.shiftKey ? 1 : -1)
      return
    }
    if (mod && event.key.toLowerCase() === 'y') {
      event.preventDefault()
      stepHistory(1)
      return
    }

    if (slash && event.key === 'Escape') {
      event.preventDefault()
      picker?.close()
      slashActive.current = false
      setSlash(null)
      return
    }

    if (event.key === 'Enter') {
      event.preventDefault()
      if (!multiline) return
      const r = selectionRange(host)
      if (r) commit(value.slice(0, r.start) + '\n' + value.slice(r.end), r.start + 1)
      return
    }

    if (event.key === 'Backspace' || event.key === 'Delete') {
      const target = adjacentChip(host, event.key === 'Backspace' ? 'before' : 'after')
      if (!target) return
      const span = chipRange(host, target)
      if (!span) return
      event.preventDefault()
      commit(value.slice(0, span.start) + value.slice(span.end), span.start)
      return
    }

    // 一次跨过整枚胶囊，而不是停在守卫零宽空格上按第二下
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (event.shiftKey || mod) return
      const dir = event.key === 'ArrowLeft' ? 'before' : 'after'
      const target = adjacentChip(host, dir)
      if (!target) return
      const span = chipRange(host, target)
      if (!span) return
      event.preventDefault()
      setCaret(host, dir === 'before' ? span.start : span.end)
    }
  }

  // --- 剪贴板 ----------------------------------------------------------------

  const onPaste = (event: ClipboardEvent<HTMLDivElement>) => {
    const host = hostRef.current
    if (!host) return
    event.preventDefault()
    let text = event.clipboardData.getData('text/plain').replace(/\r\n?/g, '\n')
    if (!multiline) text = text.replace(/\n+/g, ' ')
    const r = selectionRange(host) ?? { start: value.length, end: value.length }
    commit(value.slice(0, r.start) + text + value.slice(r.end), r.start + text.length)
  }

  /**
   * 不拦 copy 的话，复制一枚胶囊拿到的是它的**标签** ——
   * 粘到别处会变成「SQL查询·avg_dc·第1行」这段没有意义的文字。
   * 这是一条真实的静默数据损坏路径。
   */
  const onCopy = (event: ClipboardEvent<HTMLDivElement>) => {
    const host = hostRef.current
    if (!host) return
    const text = serializeSelection()
    if (!text) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', text)
  }

  const onCut = (event: ClipboardEvent<HTMLDivElement>) => {
    const host = hostRef.current
    if (!host) return
    const text = serializeSelection()
    if (!text) return
    event.preventDefault()
    event.clipboardData.setData('text/plain', text)
    const r = selectionRange(host)
    if (r) commit(value.slice(0, r.start) + value.slice(r.end), r.start)
  }

  const empty = value === ''

  return (
    <>
      <div
        ref={hostRef}
        className={[
          'reffield', multiline ? 'reffield--multi' : 'reffield--single',
          mono ? 'mono' : '', className ?? '',
        ].filter(Boolean).join(' ')}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline={multiline}
        aria-label={ariaLabel}
        aria-invalid={ariaInvalid}
        aria-autocomplete="list"
        aria-expanded={slash !== null}
        data-placeholder={empty ? placeholder : undefined}
        spellCheck={false}
        autoCorrect="off"
        autoCapitalize="off"
        style={multiline ? { minHeight: `${(rows ?? 4) * 1.6}em` } : undefined}
        onCompositionStart={() => { composing.current = true }}
        onCompositionEnd={() => {
          composing.current = false
          // Safari 有时不补发尾随 input，自己补一次。flush 幂等，多来一次无害
          queueMicrotask(flush)
        }}
        onInput={() => { if (!composing.current) flush() }}
        onKeyDown={onKeyDown}
        onKeyUp={() => { if (!composing.current) flush() }}
        onMouseUp={() => { if (!composing.current) flush() }}
        onMouseDown={(event) => {
          const target = event.target instanceof Element ? event.target.closest<HTMLElement>('[data-chip-raw]') : null
          const host = hostRef.current
          if (!target || !host) return
          // 胶囊 contentEditable=false，不拦住的话双击会选中旁边的字而不是展开
          event.preventDefault()
          host.focus()
          if (pickTimer.current !== null) {
            window.clearTimeout(pickTimer.current)
            pickTimer.current = null
          }
          if (chipClickIntent(event.detail) === 'expand') {
            picker?.close()
            slashActive.current = false
            setSlash(null)
            expandChip(host, target)
            return
          }
          if (!picker || !nodeId) return
          const span = chipRange(host, target)
          const raw = target.getAttribute('data-chip-raw') ?? ''
          if (!span || !raw) return
          pickTimer.current = window.setTimeout(() => {
            pickTimer.current = null
            slashActive.current = false
            picker.open({
              nodeId,
              query: '',
              mixed: (value.slice(0, span.start) + value.slice(span.end)).trim().length > 0,
              expectedType,
              initialExpression: raw,
              replace: (snippet) => commit(value.slice(0, span.start) + snippet + value.slice(span.end), span.start + snippet.length),
            })
          }, 280)
        }}
        onPaste={onPaste}
        onCopy={onCopy}
        onCut={onCut}
        onBlur={() => {
          if (composing.current) return // 带着候选窗口点走时不要重建
          if (pickTimer.current !== null) {
            window.clearTimeout(pickTimer.current)
            pickTimer.current = null
          }
          setTimeout(() => setSlash(null), 150)
          // 先收下展开态里改过的字，再重建：手敲的 {{ }} 和双击展开的原文都会重新收成胶囊
          flush()
          bump(null)
        }}
      />
    </>
  )
})
