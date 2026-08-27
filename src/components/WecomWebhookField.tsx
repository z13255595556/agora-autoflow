import { useEffect, useState } from 'react'
import { pushToast } from '../lib/toast'

/**
 * 一个企微群机器人地址的输入框 + 保存。**两处在用：**
 * 单条流程的「失败时通知」（Inspector）和用户级默认（首页的 NotifySettingsDialog）。
 *
 * 抽出来不是为了少写几行，而是因为这几条行为一旦两边不一致就会出真问题：
 *
 * - **密码态输入框。** 群机器人地址等同凭证，不该在共享屏幕/录屏里裸奔。
 * - **不跟自动保存走。** 草稿是编辑器每几秒一次的自动保存、不记审计；
 *   通知配置是运维设置，改一次记一次，所以有自己的「保存」按钮。
 * - **加载中不给编辑。** 读回来之前就能打字的话，慢网络下用户填一半会被
 *   服务端返回的旧值覆盖掉 —— 而覆盖是静默的。
 * - **dirty 判定用 trim 后的值比。** 否则末尾一个空格就让「保存」一直亮着。
 *
 * 受控组件：值和读写都在外面，这里只管**怎么呈现和什么时候能点**。
 * 地址合不合法由服务端判（flowstore._clean_wecom_webhook）——
 * 前端再判一次就是第二个实现，两份规则迟早会漂。
 */
export interface WecomWebhookFieldProps {
  /** 服务端当前的值。'' = 没配，null = 还没读回来 */
  loaded: string | null
  /** 保存。抛出的错会显示在输入框下面 */
  onSave: (webhook: string | null) => Promise<string>
  /** 保存成功后的提示语。参数是保存后的值（'' 表示关掉了） */
  toastFor: (saved: string) => string
  /** 输入框下面那行说明 */
  desc?: React.ReactNode
  label?: string
  onSaved?: (saved: string) => void
}

export default function WecomWebhookField({
  loaded, onSave, toastFor, desc, label = '企微群机器人地址', onSaved,
}: WecomWebhookFieldProps) {
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // 外面读回来（或保存后刷新）就同步进草稿。**只认 loaded 的变化** ——
  // 依赖里放 draft 的话每敲一个字都会被重置回服务端的值
  useEffect(() => { if (loaded !== null) setDraft(loaded) }, [loaded])

  const dirty = loaded !== null && draft.trim() !== loaded

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const saved = await onSave(draft.trim() || null)
      setDraft(saved)
      onSaved?.(saved)
      pushToast({ tone: 'ok', text: toastFor(saved) })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="field">
      <label className="field__label">{label}</label>
      <input
        type="password"
        autoComplete="off"
        value={draft}
        placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=…"
        disabled={loaded === null || busy}
        onChange={(e) => setDraft(e.target.value)}
      />
      {desc ? <div className="field__desc">{desc}</div> : null}
      {error && <div className="field__errors" role="alert">{error}</div>}
      <div className="notify__actions">
        <button className="btn btn--sm btn--primary" disabled={!dirty || busy} onClick={() => void save()}>
          {busy ? '保存中…' : draft.trim() ? '保存' : loaded ? '关闭通知' : '保存'}
        </button>
        {dirty && !busy && (
          <button className="btn btn--sm" onClick={() => setDraft(loaded ?? '')}>撤销修改</button>
        )}
      </div>
    </div>
  )
}
