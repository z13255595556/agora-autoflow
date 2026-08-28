import { useEffect, useRef } from 'react'
import { EditorState } from '@codemirror/state'
import { EditorView, keymap } from '@codemirror/view'
import { indentWithTab } from '@codemirror/commands'
import { HighlightStyle, indentUnit, syntaxHighlighting } from '@codemirror/language'
import { python } from '@codemirror/lang-python'
import { tags } from '@lezer/highlight'
import { basicSetup } from 'codemirror'

/**
 * 代码字段的编辑器（CodeMirror 6）。x-no-template 字段专用。
 *
 * 刻意**不是** RefField：代码字段不参与模板插值（红线，见 types.ts 的
 * x-no-template），而 RefField 的整套价值 —— {{ }} 胶囊、斜杠选变量、
 * 引用翻译 —— 在这里全是误导：它们会让人以为代码里能写引用。
 * 数据只从「输入变量」进来，编辑器就该是一个纯粹的代码编辑器。
 *
 * 颜色全走 CSS 变量：深浅色跟着应用一起切，不用维护两套主题。
 */

const theme = EditorView.theme({
  '&': { backgroundColor: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { fontFamily: 'var(--mono)', fontSize: '12.5px', lineHeight: '1.55' },
  '.cm-content': { caretColor: 'var(--text)', minHeight: 'var(--code-min, 180px)', padding: '8px 0' },
  '.cm-gutters': {
    backgroundColor: 'var(--surface-2)', color: 'var(--text-faint)',
    borderRight: '1px solid var(--border)',
  },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-activeLineGutter': { backgroundColor: 'var(--surface-3)' },
  '.cm-cursor': { borderLeftColor: 'var(--text)' },
  '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--primary-soft)' },
})

const highlight = HighlightStyle.define([
  { tag: tags.keyword, color: 'var(--primary)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--ok)' },
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: [tags.number, tags.bool], color: 'var(--warn)' },
  { tag: [tags.function(tags.variableName), tags.function(tags.propertyName)], color: 'var(--primary-hover)' },
])

export default function CodeEditor({
  value,
  onChange,
  rows = 10,
  ariaInvalid,
  placeholder,
}: {
  value: string
  onChange: (next: string) => void
  rows?: number
  ariaInvalid?: boolean
  placeholder?: string
}) {
  const host = useRef<HTMLDivElement>(null)
  const viewRef = useRef<EditorView | null>(null)
  // onChange 走 ref：编辑器实例只建一次，不能把它拴在每次渲染都变的闭包上
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  useEffect(() => {
    if (!host.current) return
    const view = new EditorView({
      state: EditorState.create({
        doc: value,
        extensions: [
          basicSetup,
          python(),
          keymap.of([indentWithTab]),
          indentUnit.of('    '),
          theme,
          syntaxHighlighting(highlight),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) onChangeRef.current(u.state.doc.toString())
          }),
        ],
      }),
      parent: host.current,
    })
    viewRef.current = view
    return () => { view.destroy(); viewRef.current = null }
    // 只建一次；外部 value 变化由下面的同步 effect 处理
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 外部 value 变了（换节点、撤销）→ 全量替换。自己敲键盘触发的回灌在这里
  // 恰好相等，不会 dispatch —— 光标不跳
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    const cur = view.state.doc.toString()
    if (cur !== value) view.dispatch({ changes: { from: 0, to: cur.length, insert: value } })
  }, [value])

  return (
    <div
      ref={host}
      className={`codeeditor${ariaInvalid ? ' codeeditor--invalid' : ''}`}
      style={{ ['--code-min' as string]: `${rows * 19}px` }}
      data-placeholder={placeholder}
    />
  )
}
