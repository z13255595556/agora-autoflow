import { useEffect, useState } from 'react'
import { getMyNotify, setMyNotify } from '../lib/client'
import WecomWebhookField from './WecomWebhookField'
import Icon from './Icon'

/**
 * 个人的失败通知设置。**配一次，管你名下所有流程。**
 *
 * 在此之前告警只能按流程配（流程设置里的「失败时通知」）：想收到告警，
 * 得进每一条流程各配一遍；新建一条就默默地没有告警 —— 而"这条没有告警"
 * 这件事不会以任何形式表现出来，直到某天日报没发出来也没人知道。
 *
 * 只覆盖**自己的**流程（flows.owner = 我）。无主流程（008 迁移之前建的）
 * 没有主人，也就没有"通知谁"这个答案，不发 —— 见 worker/alerts.ts 的 LEFT JOIN。
 */
export default function NotifySettingsDialog({ onClose }: { onClose: () => void }) {
  const [loaded, setLoaded] = useState<string | null>(null)   // 服务端当前的值（'' = 没配）
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    let alive = true
    getMyNotify()
      .then((r) => { if (alive) setLoaded(r.notifyConfig?.webhook ?? '') })
      .catch((err) => {
        if (alive) setError(err instanceof Error ? err.message : String(err))
      })
    return () => { alive = false }
  }, [])

  return (
    <div className="modal__mask" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">失败通知</span>
          <button className="modal__x" onClick={onClose} title="关闭"><Icon name="close" /></button>
        </div>
        <div className="modal__note">名下流程整条失败才发，同一原因 10 分钟内不重复。</div>
        {error && <div className="errors">读不到通知设置：{error}</div>}
        <WecomWebhookField
          loaded={error ? '' : loaded}
          onSave={async (hook) => {
            const r = await setMyNotify(hook)
            return r.notifyConfig?.webhook ?? ''
          }}
          onSaved={setLoaded}
          toastFor={(saved) => (saved ? '失败通知已开启' : '失败通知已关闭')}
          desc="群机器人地址等同凭证。留空保存=关闭。单条流程可覆盖。"
        />
      </div>
    </div>
  )
}
