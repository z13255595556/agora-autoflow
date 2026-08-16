import { useCallback, useEffect, useState } from 'react'
import { useFlow } from '../store'
import * as api from '../lib/client'
import { storageMode } from '../lib/library'
import { curlExample, settingsDrift, webhookUrl, type AuthMode } from '../lib/webhookExample'
import Icon from './Icon'
import FlowInputsEditor from './FlowInputsEditor'

/**
 * Webhook 触发节点的地址面板。
 *
 * 在此之前画布上有「Webhook 触发」这个节点、服务端有完整的触发链路，
 * 唯独**没有任何地方显示地址** —— 用户拖了节点、填了认证方式，然后无从下手。
 * 而地址不是配置出来的：它要先调一次接口生成 token 和调用密钥。
 *
 * 所以这个面板承担三件容易出错的事：
 * 1. 地址的域名部分怎么拼（开发和部署两种形态答案不同）
 * 2. 地址和密钥可持续查看、复制；历史上只存 hash 的记录需轮换一次
 * 3. **没发布的流程，webhook 打过来是 409**。这是最常见的困惑，提前说
 */
export default function WebhookPanel({ nodeParams }: { nodeParams: Record<string, unknown> }) {
  const flowId = useFlow((s) => s.flowId)
  const flowInputs = useFlow((s) => s.flowInputs)
  const setWebhookReady = useFlow((s) => s.setWebhookReady)

  const [view, setView] = useState<api.WebhookView | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const serverMode = storageMode() === 'server'

  const load = useCallback(async () => {
    if (!serverMode) return
    setError(null)
    try {
      const next = await api.getFlowWebhook(flowId)
      setView(next)
      // 画布上那行「地址没生成」跟着走，不然生成完还挂着
      setWebhookReady(Boolean(next.webhook))
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [flowId, serverMode, setWebhookReady])

  useEffect(() => { void load() }, [load])

  const act = async (fn: () => Promise<api.RemoteWebhook>) => {
    setBusy(true)
    setError(null)
    try {
      await fn()
      await load()
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }

  if (!serverMode) {
    return (
      <>
        <WebhookInputs />
        <div className="section">
          <div className="section__head section__head--static">触发地址</div>
          <div className="section__body">
            <div className="wh__warn">
              <b>未连接流程存储，webhook 用不了。</b>
              <span>
                触发地址、密钥、投递记录都存在服务端；而且外部系统要打得到的是服务器，
                不是你这台浏览器。给服务端配上 <code>DATABASE_URL</code> 后这里会出现地址。
              </span>
            </div>
          </div>
        </div>
      </>
    )
  }

  const hook = view?.webhook ?? null
  const authMode = (hook?.authMode ?? 'secret') as AuthMode
  const secret = hook?.secret ?? null
  const url = hook ? webhookUrl(api.webhookOrigin(), hook.token) : ''
  const drift = hook ? settingsDrift(nodeParams, hook) : []
  const published = view ? view.activeVersion !== null : true

  return (
    <>
      <WebhookInputs />
      <div className="section">
      <div className="section__head section__head--static">
        触发地址
        {hook && !hook.enabled && <em className="wh__off">已停用</em>}
      </div>
      <div className="section__body">
        {error && <div className="wh__err">{error}</div>}

        {!hook ? (
          <>
            <div className="wh__empty">
              地址还没生成。它不是配置出来的 —— 要先在服务端建一条记录，
              拿到一段不可枚举的 token 和调用密钥。生成后可以随时回来查看、复制。
            </div>
            <button
              className="btn btn--primary"
              disabled={busy || !view}
              onClick={() => act(() => api.createFlowWebhook(flowId, {
                authMode: typeof nodeParams.authMode === 'string' ? nodeParams.authMode : undefined,
                rateLimitPerMin: typeof nodeParams.rateLimitPerMin === 'number' ? nodeParams.rateLimitPerMin : undefined,
                responseMode: typeof nodeParams.responseMode === 'string' ? nodeParams.responseMode : 'lastNode',
                responseTimeoutSeconds: typeof nodeParams.responseTimeoutSeconds === 'number'
                  ? nodeParams.responseTimeoutSeconds : 300,
              }))}
            >
              {busy ? '生成中…' : '生成触发地址'}
            </button>
          </>
        ) : (
          <>
            {/* ★ 没发布 = 打过来必然 409。放在最上面，别让用户从上游的报错里发现 */}
            {!published && (
              <div className="wh__warn">
                <b>流程尚未发布，这个地址现在打过来会返回 409。</b>
                <span>
                  webhook 只触发<b>已发布</b>的那一版 —— 草稿改坏了不该影响线上调用。
                  顶栏点一次「发布」它就生效。
                </span>
              </div>
            )}

            <CopyRow label="POST 地址" value={url} mono />

            {secret ? (
              <div className="wh__secret">
                <div className="wh__secret-head">
                  <b>密钥</b>
                  <span>可以随时在这里查看和复制。</span>
                </div>
                <CopyRow label="" value={secret} mono />
              </div>
            ) : authMode !== 'none' && (
              <div className="wh__hint">
                这是旧版本生成的地址，当时没有保存可回显的密钥。请<b>轮换</b>一次；
                轮换后新密钥会持续显示，但旧地址和旧密钥会立即失效。
              </div>
            )}

            <div className="wh__meta">
              <span>认证 <b>{AUTH_LABEL[authMode]}</b></span>
              <span>限流 <b>{hook.rateLimitPerMin}/分钟</b></span>
              <span>
                响应 <b>{hook.responseMode === 'immediate' ? '立即返回运行 ID' : `等待结果 · ${hook.responseTimeoutSeconds} 秒`}</b>
              </span>
            </div>

            {drift.length > 0 && (
              <div className="wh__warn">
                <b>节点上改了配置，但还没生效。</b>
                <span>{drift.join('；')}</span>
                <span className="wh__warn-sub">
                  改认证方式会让上游当前的调用<b>立刻 401</b>，所以它不跟着保存走，得点一下。
                </span>
                <button
                  className="btn btn--sm"
                  disabled={busy}
                  onClick={() => act(() => api.updateFlowWebhook(flowId, {
                    authMode: typeof nodeParams.authMode === 'string' ? nodeParams.authMode : undefined,
                    rateLimitPerMin: typeof nodeParams.rateLimitPerMin === 'number' ? nodeParams.rateLimitPerMin : undefined,
                    responseMode: typeof nodeParams.responseMode === 'string' ? nodeParams.responseMode : undefined,
                    responseTimeoutSeconds: typeof nodeParams.responseTimeoutSeconds === 'number'
                      ? nodeParams.responseTimeoutSeconds : undefined,
                  }))}
                >
                  应用到线上
                </button>
              </div>
            )}

            <CopyRow
              label="调用示例（按当前流程入参生成）"
              value={curlExample({ url, authMode, secret, inputs: flowInputs })}
              block
            />
            <div className="wh__hint">
              body 顶层<b>同名</b>字段自动当流程入参，<b>没声明过的字段直接丢掉</b>；
              类型对不上或缺必填会被 400 挡在门外，不会产生运行记录。
            </div>

            <Deliveries rows={view?.deliveries ?? []} onRefresh={load} />

            <div className="wh__ops">
              <button
                className="btn btn--sm"
                disabled={busy}
                onClick={() => act(() => api.updateFlowWebhook(flowId, { enabled: !hook.enabled }))}
              >
                {hook.enabled ? '停用' : '启用'}
              </button>
              <button
                className="btn btn--sm btn--danger"
                disabled={busy}
                onClick={() => {
                  if (!confirm('轮换后旧地址和旧密钥立刻失效，正在调用的上游系统会全部报错。确定？')) return
                  void act(() => api.rotateFlowWebhook(flowId))
                }}
              >
                轮换地址和密钥
              </button>
            </div>
          </>
        )}
      </div>
      </div>
    </>
  )
}

function WebhookInputs() {
  return (
    <div className="section">
      <div className="section__head section__head--static">
        请求入参
        <em>POST body 顶层字段</em>
      </div>
      <div className="section__body">
        <FlowInputsEditor context="webhook" />
      </div>
    </div>
  )
}

const AUTH_LABEL: Record<AuthMode, string> = {
  secret: '密钥请求头',
  hmac: 'HMAC 签名',
  none: '不认证',
}

/** 一行可复制的值。复制失败要说出来 —— 静默失败会让人以为已经复制了 */
function CopyRow({ label, value, mono, block }: { label: string; value: string; mono?: boolean; block?: boolean }) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle')

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value)
      setState('ok')
    } catch {
      // 非安全上下文（裸 http 的内网 IP）下 clipboard API 直接不可用
      setState('fail')
    }
    setTimeout(() => setState('idle'), 2000)
  }

  return (
    <div className={`wh__copy${block ? ' wh__copy--block' : ''}`}>
      {label && <label className="field__label">{label}</label>}
      <div className="wh__copy-row">
        {block
          ? <pre className="wh__code">{value}</pre>
          : <code className={mono ? 'wh__val mono' : 'wh__val'}>{value}</code>}
        <button className="btn btn--sm" onClick={copy} title="复制">
          {state === 'ok' ? '已复制' : state === 'fail' ? '复制失败' : <Icon name="copy" size={13} />}
        </button>
      </div>
      {state === 'fail' && <span className="wh__err-sub">浏览器不允许自动复制（非 HTTPS 页面），请手动选中</span>}
    </div>
  )
}

/**
 * 投递记录。**被拒绝的也在里面** ——「上游说发了但没跑」是这类集成最常见的争议，
 * 而这张表就是唯一的证据。
 */
function Deliveries({ rows, onRefresh }: { rows: api.WebhookDelivery[]; onRefresh: () => void }) {
  const [open, setOpen] = useState(false)
  const bad = rows.filter((r) => r.statusCode >= 400).length

  return (
    <div className="wh__deliv">
      <button className="wh__deliv-head" onClick={() => setOpen(!open)}>
        <span>{open ? '▾' : '▸'}</span> 最近投递
        <em>{rows.length} 条{bad > 0 ? ` · ${bad} 条被拒` : ''}</em>
      </button>
      {open && (
        <>
          <div className="wh__deliv-bar">
            <button className="linkbtn" onClick={onRefresh}>刷新</button>
            <span>不记录 body 原文 —— 里面可能有用户 id、手机号</span>
          </div>
          {rows.length === 0 ? (
            <div className="empty">还没有收到过请求。上游打一次这里就有记录，被拒的也会记。</div>
          ) : (
            <table className="wh__table">
              <tbody>
                {rows.map((r, i) => (
                  <tr key={i} className={r.statusCode >= 400 ? 'wh__row--bad' : undefined}>
                    <td className="mono">{r.receivedAt.slice(11, 19)}</td>
                    <td className="mono">{r.statusCode}</td>
                    <td className="mono">{r.remoteIp ?? '—'}</td>
                    <td title={r.rejectReason ?? r.runId ?? ''}>
                      {r.rejectReason ?? r.runId ?? '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </>
      )}
    </div>
  )
}
