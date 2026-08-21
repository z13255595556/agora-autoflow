import { useEffect, useState } from 'react'
import { listRemoteVersions, type FlowVersionMeta } from '../lib/client'
import { formatDate } from '../lib/datefn'
import Icon from './Icon'

/**
 * 版本这件事的两个界面：发布时填变更说明，事后按版本回看和切回去。
 *
 * 在此之前版本号是**没有内容的**：列表里只有「v3 · 2026-08-21 · alice」，
 * "这一版改了什么"没有任何地方答得上来 —— 而那恰恰是回滚前唯一想知道的事。
 * 靠 diff 两份 definition 也答不了：JSON 差异说得出"某个节点的 sql 变了"，
 * 说不出"改成按天分区，之前扫全表超时"。
 */

/** 和服务端 flowstore.NOTE_MAX 对齐。超了服务端会截断，界面先拦住 */
export const NOTE_MAX = 500

export function PublishDialog({
  nextVersion,
  onCancel,
  onPublish,
}: {
  /** 这次会发成第几版。从没发布过时调用方传 1 */
  nextVersion: number
  onCancel: () => void
  onPublish: (note: string) => Promise<string | null>
}) {
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const go = async () => {
    setBusy(true)
    const err = await onPublish(note)
    setBusy(false)
    if (err) window.alert(`发布失败：${err}`)
    else onCancel()
  }

  return (
    <div className="modal__mask" onClick={() => !busy && onCancel()}>
      <div className="modal modal--narrow" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">发布 v{nextVersion}</span>
          <button className="modal__x" onClick={onCancel} disabled={busy}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal__note">
          把当前草稿定为 v{nextVersion} 并设为生效。定时和 Webhook 触发的都是这一版。
        </div>

        <label className="vpub__label" htmlFor="publish-note">
          这一版改了什么<em>选填</em>
        </label>
        <textarea
          id="publish-note"
          className="vpub__note"
          value={note}
          maxLength={NOTE_MAX}
          rows={3}
          autoFocus
          disabled={busy}
          placeholder="例：SQL 改成按天分区，之前扫全表会超时"
          onChange={(e) => setNote(e.target.value)}
          /* ⌘/Ctrl+Enter 直接发。手写换行是这个框里的常态，
             不能把光标的 Enter 抢走 */
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') void go()
          }}
        />
        {/* 只在快满时出现。一个常驻的字数计数器会把"选填"这件事说成一道考题 */}
        {note.length > NOTE_MAX - 80 && (
          <div className="vpub__count">还能写 {NOTE_MAX - note.length} 个字</div>
        )}

        <div className="vpub__foot">
          {/* 说出不填的后果，而不是催着填。空着是诚实的，
              随手敲一个「更新」比空着更糟 */}
          <span className="vpub__hint">不填也能发，只是这一版在历史里说不出改了什么。</span>
          <button className="btn" onClick={onCancel} disabled={busy}>取消</button>
          <button className="btn btn--primary" onClick={() => void go()} disabled={busy}>
            {busy ? '发布中…' : `发布 v${nextVersion}`}
          </button>
        </div>
      </div>
    </div>
  )
}

export function VersionHistory({
  flowId,
  activeVersion,
  onClose,
  onRollback,
}: {
  flowId: string
  activeVersion: number | null
  onClose: () => void
  /** 返回错误信息表示失败，null 表示成功 */
  onRollback: (version: number) => Promise<string | null>
}) {
  const [versions, setVersions] = useState<FlowVersionMeta[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState<number | null>(null)

  useEffect(() => {
    let cancelled = false
    void listRemoteVersions(flowId)
      .then((got) => { if (!cancelled) setVersions(got) })
      .catch((err) => {
        // 读不到要说出来。空列表和"读失败"在界面上长得一样，
        // 而它们的下一步动作完全不同
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [flowId])

  const rollback = async (v: FlowVersionMeta) => {
    const ok = window.confirm(
      `把线上切回 v${v.version}？\n\n` +
      `· 定时和 Webhook 下一次触发就跑 v${v.version}\n` +
      '· 编辑器里的草稿会被 v' + v.version + ' 覆盖 —— 你现在画布上的内容会没掉\n' +
      `· 不会产生新版本，当前的 v${activeVersion} 仍然留在历史里，随时能切回来\n\n` +
      '想留个底的话，先取消，用「流程 JSON」导出一份。',
    )
    if (!ok) return
    setBusy(v.version)
    const err = await onRollback(v.version)
    setBusy(null)
    if (err) window.alert(`切换失败：${err}`)
    else onClose()
  }

  return (
    <div className="modal__mask" onClick={() => busy === null && onClose()}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">历史版本</span>
          <button className="modal__x" onClick={onClose}>
            <Icon name="close" />
          </button>
        </div>
        <div className="modal__note">
          线上（定时 / Webhook）跑的是标着「生效中」的那一版。切换会<b>立刻</b>改变线上行为，
          并覆盖编辑器里的草稿。
        </div>

        {error ? (
          <div className="empty">读不到版本历史：{error}</div>
        ) : versions === null ? (
          <div className="empty">正在读取…</div>
        ) : versions.length === 0 ? (
          <div className="empty">还没有发布过。发布一次就会有 v1。</div>
        ) : (
          <div className="vhist">
            {versions.map((v) => {
              const on = v.version === activeVersion
              return (
                <div className={`vhist__row${on ? ' on' : ''}`} key={v.version}>
                  <div className="vhist__no">
                    v{v.version}
                    {on && <b className="vhist__live">生效中</b>}
                  </div>
                  {/* 没填说明的那些要看得出来是"没填"，不是"没改动"。
                      013 之前发布的一律没有说明，它们是基线 */}
                  <div className={`vhist__note${v.note ? '' : ' vhist__note--none'}`}>
                    {v.note ?? '没有填写变更说明'}
                  </div>
                  <div className="vhist__meta">
                    {formatDate(new Date(v.createdAt), 'yyyy-MM-dd HH:mm')}
                    {v.createdBy && ` · ${v.createdBy}`}
                  </div>
                  <div className="vhist__act">
                    {!on && (
                      <button
                        className="btn btn--sm"
                        disabled={busy !== null}
                        onClick={() => void rollback(v)}
                      >
                        {busy === v.version ? '切换中…' : '切到这一版'}
                      </button>
                    )}
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
