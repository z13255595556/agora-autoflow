import { useCallback, useEffect, useRef } from 'react'
import { useFlow, type FNode } from '../store'
import type { NodeType } from '../types'
import Icon from './Icon'
import FlowInputFields, { focusMissingInput } from './FlowInputFields'
import { validateNode } from '../lib/vars'
import { defaultForm, missingRequiredInputs, stepRunBlockers } from '../lib/runRequest'
import { stepRunState } from '../lib/runLabel'
import { focusValidationField } from '../lib/validationFocus'

/**
 * 节点编辑页底部的运行条。
 *
 * 重点不是"又多了一个运行按钮"，是**运行前的那一步**：
 *
 * 单节点试运行和整条运行读的是同一份 `$.trigger.*`（store.testStep 把手动
 * 表单的值拼进 trigger），而填 trigger 的表单一直只长在底部运行面板上 ——
 * 节点编辑页是全屏模态，`.ndv__mask` 正好把那个面板整个盖住。于是在编辑页里
 * 按「试运行」，跑的是一份**入参为空**的运行：节点是绿的、输出有行、数字是
 * 错的，界面上没有任何迹象。而且本地基本复现不出来 —— 本机 localStorage 里
 * 通常还留着上次填的入参（recallInputs），空的那次只发生在别人的浏览器上。
 *
 * 所以表头那颗按钮**不再直接执行**，它只负责把这条展开；真正的执行入口在这
 * 条里、和它要用的入参并排放着：先看清楚这次拿什么去跑、缺的当场补上，
 * 再手动按下去。
 */
export default function NdvRunBar({
  node,
  type,
  open,
  onOpen,
}: {
  node: FNode
  type: NodeType
  /** 入参那一排展开了没。收起时这条只剩状态 + 运行按钮一行 */
  open: boolean
  onOpen: () => void
}) {
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const form = useFlow((s) => s.manualInputs)
  const setForm = useFlow((s) => s.setManualInputs)
  const running = useFlow((s) => s.running)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const pinData = useFlow((s) => s.pinData)
  const unpinNode = useFlow((s) => s.unpinNode)
  const testStep = useFlow((s) => s.testStep)
  const dirtyNodes = useFlow((s) => s.dirtyNodes)

  const formRef = useRef<HTMLDivElement>(null)

  const run = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null
  const lastStep = run?.steps[node.id]?.at(-1)
  const isPinned = Object.prototype.hasOwnProperty.call(pinData, node.id)
  const errors = validateNode(node, nodes, edges, flowInputs)
  const blockers = stepRunBlockers({ running, nodeErrors: errors, flowInputs, form })
  const state = stepRunState({ running, lastStep, dirty: Boolean(dirtyNodes[node.id]) })
  const hasDefaults = flowInputs.some((f) => f.default !== undefined && f.default !== '')

  // 展开的那一下把光标送进第一个还空着的必填入参 —— 展开这条多半就是为了填它
  useEffect(() => {
    if (open) focusMissingInput(formRef.current, missingRequiredInputs(flowInputs, form)[0]?.key)
    // 只在展开的那一刻做一次：入参一边打字一边重算，跟着 form 走会把光标抢回去
  }, [open])

  /**
   * 按钮**不置灰**，理由和顶栏那颗运行一样：灰按钮只说"不能按"，不说为什么。
   * 拦下来的这一下要把人带到要改的那一格上 —— 缺入参就展开这条并聚焦空着的那格，
   * 参数错就滚到参数栏里出错的那个字段（focusValidationField）。
   */
  const onRun = useCallback(() => {
    if (running) return
    if (errors.length > 0) {
      focusValidationField(errors[0], type.input)
      return
    }
    const missing = missingRequiredInputs(flowInputs, form)
    if (missing.length > 0) {
      onOpen()
      focusMissingInput(formRef.current, missing[0].key)
      return
    }
    // n8n：对 pinned 节点执行 Test step 会覆盖固定数据 → 先弹确认（Unpin and test）
    if (isPinned) {
      if (!confirm('该节点输出已固定。试运行将取消固定并真实执行，继续？')) return
      unpinNode(node.id)
    }
    void testStep(node.id)
  }, [running, errors, type.input, flowInputs, form, onOpen, isPinned, unpinNode, node.id, testStep])

  // ⌘/Ctrl+Enter 和侧栏同键。侧栏在 NDV 打开时是卸掉的（见 App.tsx），
  // 两个监听不会同时在，按一下不会跑两遍
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.isComposing) return
      if (event.key !== 'Enter' || (!event.metaKey && !event.ctrlKey) || event.shiftKey) return
      event.preventDefault()
      onRun()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onRun])

  return (
    <div className="ndvrun">
      {open && (
        <div className="ndvrun__form" ref={formRef}>
          <span className="ndvrun__label" title="这条流程的入参。填的值就是这次试运行的 $.trigger.*，和底部运行面板是同一份">
            运行入参
          </span>
          {flowInputs.length === 0 ? (
            <span className="ndvrun__hint">这条流程没有入参；要加在「流程设置 · 流程入参」里</span>
          ) : (
            <>
              <FlowInputFields fields={flowInputs} form={form} onChange={setForm} fieldClassName="ndvrun__field" />
              {hasDefaults && (
                <button className="linkbtn" onClick={() => setForm(defaultForm(flowInputs))} title="把入参恢复成默认值">
                  恢复默认
                </button>
              )}
            </>
          )}
        </div>
      )}
      <div className="ndvrun__foot">
        {/* 和侧栏那颗状态胶囊共用一套 class：同一件事，长得不一样只会让人以为是两回事 */}
        <span className={`insrun__state insrun__state--${state.tone}`} title={lastStep?.error}>
          <i />{state.text}
        </span>
        {blockers.length > 0 ? (
          <span className="ndvrun__block" role="status">⚠ {blockers[0]}</span>
        ) : (
          <span className="ndvrun__hint">
            上游用最近一次运行的输出（固定数据优先），只跑这一个节点
          </span>
        )}
        <button
          className="btn btn--primary ndvrun__go"
          disabled={running}
          title={blockers[0] ?? '只执行这个节点（⌘/Ctrl+Enter）'}
          onClick={onRun}
        >
          <Icon name="play" size={12} /> {running ? '运行中…' : '运行本节点'}
        </button>
      </div>
    </div>
  )
}
