import { Fragment, useCallback, useEffect, useRef, useState } from 'react'
import {
  adminAddSandboxPackage, adminRemoveSandboxPackage, adminSandboxPackages,
  type SandboxPackagesOverview,
} from '../lib/client'
import Icon from './Icon'

/**
 * Python 依赖管理（管理员）。
 *
 * 用户代码不许自装包 —— pip 的安装脚本本身就是任意代码，供应链面收在这里。
 * 这一页改的是 sandbox_packages 表（唯一正本），服务端对账线程把沙箱 venv
 * 收敛成表的样子；所以「加了包」到「能 import」之间有一段 pending ——
 * 装 pandas 要几分钟，页面在有进行中的行时每 3 秒刷一次。
 *
 * 删种子包也允许（管理员自治），但已用它的流程会开始报 ImportError ——
 * 删除前的确认里要把这句说出来。
 */

const STATUS_TEXT: Record<string, string> = {
  pending: '待安装',
  installed: '已安装',
  failed: '安装失败',
  removing: '卸载中',
}

const MODE_NOTE: Record<SandboxPackagesOverview['mode'], string> = {
  remote: '沙箱服务模式（SANDBOX_URL）：这份清单只作展示，包生态由沙箱服务自己管理。',
  local: '本地子进程模式：包装进 server/.venv-sandbox，改动几秒到几分钟后生效。',
  off: 'Python 代码节点未启用 —— 本地开发在 server/.env 配 CODE_NODE_LOCAL_EXEC=1，生产配 SANDBOX_URL。清单可以先改，启用后生效。',
}

export default function SandboxPackages({ onClose }: { onClose: () => void }) {
  const [data, setData] = useState<SandboxPackagesOverview | null>(null)
  const [err, setErr] = useState('')
  const [name, setName] = useState('')
  const [version, setVersion] = useState('')
  const [busy, setBusy] = useState(false)
  const [openLog, setOpenLog] = useState<string | null>(null)
  const timer = useRef<number | null>(null)

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const load = useCallback(() => {
    adminSandboxPackages()
      .then((got) => {
        setData(got)
        setErr('')
        // 有进行中的行才轮询 —— 清单稳定时这页不该在后台打点
        const active = got.reconciling
          || got.packages.some((p) => p.status === 'pending' || p.status === 'removing')
        if (timer.current) window.clearTimeout(timer.current)
        if (active) timer.current = window.setTimeout(load, 3000)
      })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }, [])

  useEffect(() => {
    load()
    return () => { if (timer.current) window.clearTimeout(timer.current) }
  }, [load])

  const add = () => {
    if (!name.trim() || !version.trim() || busy) return
    setBusy(true)
    adminAddSandboxPackage(name.trim(), version.trim())
      .then(() => { setName(''); setVersion(''); load() })
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }

  const remove = (pkg: string) => {
    if (!confirm(`卸载 ${pkg}？\n\n已经 import 它的流程会开始报 ImportError。`)) return
    adminRemoveSandboxPackage(pkg)
      .then(load)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="modal__mask" onClick={onClose}>
      <div className="modal modal--wide" onClick={(e) => e.stopPropagation()}>
        <div className="modal__head">
          <span className="modal__title">Python 依赖</span>
          <button className="modal__x" onClick={onClose} title="关闭"><Icon name="close" /></button>
        </div>
        <div className="modal__note">
          Python 代码节点的预装包。用户代码不能自装 —— 需要什么在这里加，必须钉死版本。
          {data && ` ${MODE_NOTE[data.mode]}`}
          {data && data.mode === 'local' && !data.interpreter
            && ' ⚠ 沙箱 venv 还没建：跑一次 scripts/dev.sh。'}
        </div>

        {err && <div className="errors">{err}</div>}
        {!data && !err && <div className="empty">读取中…</div>}

        {data && (
          <>
            <div className="pkgform">
              <input
                className="pkgform__name"
                placeholder="包名（如 openpyxl）"
                value={name}
                onChange={(e) => setName(e.target.value)}
              />
              <input
                className="pkgform__version"
                placeholder="版本（如 3.1.5）"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') add() }}
              />
              <button className="btn btn--primary" onClick={add} disabled={busy || !name.trim() || !version.trim()}>
                添加
              </button>
              {data.reconciling && <span className="pkgform__spin">对账中…</span>}
            </div>

            <table className="utable">
              <thead>
                <tr><th>包</th><th>版本</th><th>状态</th><th>添加人</th><th /></tr>
              </thead>
              <tbody>
                {data.packages.map((p) => (
                  // 日志是单独的整行：.utable 的单元格是 nowrap + 220px 截断，
                  // pip 输出塞在状态格里会被挤成一条省略号
                  <Fragment key={p.name}>
                    <tr>
                      <td className="mono">{p.name}</td>
                      <td className="mono">{p.version}</td>
                      <td>
                        <span className={`pkgstatus pkgstatus--${p.status}`}>{STATUS_TEXT[p.status] ?? p.status}</span>
                        {p.pipLog && (
                          <button
                            className="pkgstatus__log"
                            onClick={() => setOpenLog(openLog === p.name ? null : p.name)}
                          >
                            {openLog === p.name ? '收起日志' : 'pip 日志'}
                          </button>
                        )}
                      </td>
                      <td>{p.addedBy ?? '—'}</td>
                      <td className="num">
                        {p.status !== 'removing' && (
                          <button className="btn btn--ghost btn--sm" onClick={() => remove(p.name)}>卸载</button>
                        )}
                      </td>
                    </tr>
                    {openLog === p.name && p.pipLog && (
                      <tr><td colSpan={5} className="pkglog__cell"><pre className="pkglog">{p.pipLog}</pre></td></tr>
                    )}
                  </Fragment>
                ))}
                {data.packages.length === 0 && (
                  <tr><td colSpan={5}><div className="empty">清单是空的。</div></td></tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </div>
    </div>
  )
}
