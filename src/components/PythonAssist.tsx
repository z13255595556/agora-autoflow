import { useEffect, useRef, useState } from 'react'
import { sandboxEnv, type SandboxEnv } from '../lib/client'
import { buildPythonPrompt } from '../lib/pythonPrompt'
import { pushToast } from '../lib/toast'
import Icon from './Icon'

/**
 * Python 代码节点的助手条（由 manifest 的 x-ui.assistants 声明，SchemaForm
 * 通用渲染 —— 不是按 typeId 特判，见 docs/node-contract.md）。
 *
 * 三件事：使用说明悬浮窗、运行环境（版本 + 可用库）、复制 AI 提示词。
 * 环境信息全部来自 /sandbox/env **实时拉取** —— 文档里手抄一份库清单，
 * 迟早和实际装的对不上，而且对不上的时候没有任何报错。
 */

// 环境信息进程内缓存一分钟：hover 是高频动作，不该每次都打一个请求；
// 管理员装了新包，一分钟后自然可见
let envCache: { at: number; data: SandboxEnv } | null = null
async function loadEnv(): Promise<SandboxEnv> {
  if (envCache && Date.now() - envCache.at < 60_000) return envCache.data
  const data = await sandboxEnv()
  envCache = { at: Date.now(), data }
  return data
}

async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    // 剪贴板 API 被拒（非安全上下文等）时退回老办法
    const ta = document.createElement('textarea')
    ta.value = text
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    ta.remove()
    return ok
  }
}

function EnvList({ env, error }: { env: SandboxEnv | null; error?: string | null }) {
  // 拉取失败必须和「读取中」长得不一样 —— 以前失败也显示「读取中…」，
  // 用户看到的症状是"永远在加载"，往网络/后端上想不到。带上原始报错：
  // nginx 显式转发名单漏了 /sandbox/env 时，这里会是"非 JSON 响应（HTTP 200）：<!doctype html>…"
  if (!env && error) {
    return (
      <div className="pyenv__err">
        环境信息拉取失败：{error}
        <div className="pyenv__dim">典型原因：nginx 没把 /sandbox/env 转发给后端（落进 SPA 回退），或后端还是没有这个接口的旧版本。</div>
      </div>
    )
  }
  if (!env) return <div className="pyenv__dim">读取中…</div>
  const installed = env.packages.filter((p) => p.status === 'installed')
  const pending = env.packages.filter((p) => p.status !== 'installed')
  return (
    <>
      <div className="pyenv__row">
        <span className="pyenv__k">Python</span>
        <span>{env.python ?? (env.mode === 'off' ? '沙箱未启用' : '沙箱未就绪')}</span>
      </div>
      <div className="pyenv__row">
        <span className="pyenv__k">可用库</span>
        <span>
          {installed.length
            ? installed.map((p) => `${p.name} ${p.version}`).join(' · ')
            : '（还没有装好的包）'}
        </span>
      </div>
      {pending.length > 0 && (
        <div className="pyenv__row pyenv__dim">
          <span className="pyenv__k">进行中</span>
          <span>{pending.map((p) => `${p.name}（${p.status === 'failed' ? '安装失败' : '安装中'}）`).join(' · ')}</span>
        </div>
      )}
      <div className="pyenv__dim">需要新库找管理员在「Python 依赖」页添加，代码里不能 pip install。</div>
    </>
  )
}

export default function PythonAssist({ values }: { values: Record<string, unknown> }) {
  const [helpOpen, setHelpOpen] = useState(false)
  const [envOpen, setEnvOpen] = useState(false)
  const [env, setEnv] = useState<SandboxEnv | null>(null)
  const [envError, setEnvError] = useState<string | null>(null)
  const envBtn = useRef<HTMLButtonElement>(null)
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null)

  useEffect(() => {
    if (!helpOpen && !envOpen) return
    let cancelled = false
    loadEnv()
      .then((e) => { if (!cancelled) { setEnv(e); setEnvError(null) } })
      .catch((err: unknown) => {
        if (!cancelled) setEnvError(err instanceof Error ? err.message : String(err))
      })
    return () => { cancelled = true }
  }, [helpOpen, envOpen])

  useEffect(() => {
    if (!helpOpen) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setHelpOpen(false) }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [helpOpen])

  const showEnv = () => {
    // 固定定位而不是绝对定位：这个条挂在 Inspector 里，overflow 会把
    // 绝对定位的浮层裁掉半截
    const r = envBtn.current?.getBoundingClientRect()
    if (r) setPos({ left: Math.max(8, Math.min(r.left, window.innerWidth - 340)), top: r.bottom + 6 })
    setEnvOpen(true)
  }

  const copyPrompt = async () => {
    const inputsObj = values.inputs
    const keys = inputsObj && typeof inputsObj === 'object' && !Array.isArray(inputsObj)
      ? Object.keys(inputsObj)
      : []
    let e: SandboxEnv | null = env
    if (!e) {
      try { e = await loadEnv() } catch { e = null }
    }
    const ok = await copyText(buildPythonPrompt(keys, e))
    pushToast(ok
      ? { tone: 'ok', text: '提示词已复制 —— 贴给任意 AI，补上你的需求描述即可' }
      : { tone: 'error', text: '复制失败，浏览器不允许访问剪贴板' })
  }

  return (
    <div className="pyassist">
      <button type="button" className="pyassist__btn" onClick={() => setHelpOpen(true)}>使用说明</button>
      <button
        type="button"
        ref={envBtn}
        className="pyassist__btn"
        onMouseEnter={showEnv}
        onMouseLeave={() => setEnvOpen(false)}
        onClick={() => (envOpen ? setEnvOpen(false) : showEnv())}
      >
        运行环境
      </button>
      <button type="button" className="pyassist__btn" onClick={copyPrompt} title="复制一段带契约和环境信息的提示词，贴给任意 AI 帮你写代码">
        复制给 AI
      </button>

      {envOpen && pos && (
        <div className="pyenv" style={{ left: pos.left, top: pos.top }}
             onMouseEnter={() => setEnvOpen(true)} onMouseLeave={() => setEnvOpen(false)}>
          <EnvList env={env} error={envError} />
        </div>
      )}

      {helpOpen && (
        <div className="modal__mask" onClick={() => setHelpOpen(false)}>
          <div className="modal modal--wide pyhelp" onClick={(e) => e.stopPropagation()}>
            <div className="modal__head">
              <span className="modal__title">Python 代码节点 · 使用说明</span>
              <button className="modal__x" onClick={() => setHelpOpen(false)} title="关闭"><Icon name="close" /></button>
            </div>
            <div className="pyhelp__body">
              <h3>六十秒上手</h3>
              <ol>
                <li>在<b>「输入变量」</b>里配数据：键名随便起，值那栏用 <code>{'{{ }}'}</code> 引用上游（整栏只放一个引用时，数组/对象原样进来，不会变成字符串）。</li>
                <li>写代码，入口固定：<code>def main(inputs) -&gt; dict</code>，配的键从 <code>inputs["键名"]</code> 取。</li>
                <li>点<b>试运行</b>，输出面板分「返回值」和「日志」两块；跑过一次后返回的字段自动出现在下游变量面板。</li>
              </ol>
              <pre>{'def main(inputs):\n    rows = inputs["rows"]          # 「输入变量」里配的键\n    return {"total": len(rows)}    # 返回的键就是输出字段'}</pre>

              <div className="pyhelp__redline">
                <b>红线：</b>代码字段不做任何 <code>{'{{ }}'}</code> 替换 —— 写了也是普通文本。
                数据只能走「输入变量」，这是防注入的硬边界，不是缺功能。
              </div>

              <h3>返回值规矩</h3>
              <ul>
                <li>必须返回 dict，键直接成为输出字段（下游 <code>$.nodes.节点.output.键</code> 引用）。</li>
                <li>DataFrame 先 <code>.to_dict("records")</code>；<code>datetime</code> 自动转 ISO 串；其余转不动的会点名报错。</li>
                <li><code>logs</code> / <code>durationMs</code> 是保留键；返回值上限 10MB，大结果返回汇总。</li>
                <li><code>print</code> 随便用：全部进「日志」（各留 64KB），不影响返回值；报错带你代码的行号。</li>
              </ul>

              <h3>当前运行环境（实时）</h3>
              <div className="pyhelp__env"><EnvList env={env} error={envError} /></div>
              <p className="pyenv__dim">可以联网（requests 可用）；普通接口调用建议用 HTTP 节点，代码里联网留给签名/SDK 场景。
              超时默认 30s，「高级设置」最多 120s。</p>

              <h3>照着抄</h3>
              <p className="pyhelp__label"># SQL 结果分组汇总 —— rows ← {'{{ $.nodes.sql1.output.rows }}'}</p>
              <pre>{'import pandas as pd\n\ndef main(inputs):\n    df = pd.DataFrame(inputs["rows"])\n    by_vid = df.groupby("vid")["dc"].sum().reset_index()\n    return {\n        "total": int(df["dc"].sum()),\n        "byVid": by_vid.to_dict("records"),\n    }'}</pre>
              <p className="pyhelp__label"># 两个查询对账 —— today/last 各引用一个上游</p>
              <pre>{'def main(inputs):\n    last = {r["vid"]: r["dc"] for r in inputs["last"]}\n    rows = []\n    for r in inputs["today"]:\n        prev = last.get(r["vid"], 0)\n        rows.append({**r, "prev": prev, "delta": r["dc"] - prev})\n    rows.sort(key=lambda r: r["delta"], reverse=True)\n    return {"rows": rows[:20]}'}</pre>
              <p className="pyhelp__label"># 拼企微消息 —— 下游 content 填 {'{{ $.nodes.py1.output.text }}'}</p>
              <pre>{'def main(inputs):\n    lines = [f"## 用量 Top {len(inputs[\'rows\'])}"]\n    for i, r in enumerate(inputs["rows"], 1):\n        lines.append(f"{i}. **{r[\'vid\']}** · {r[\'dc\']:,} 分钟")\n    return {"text": "\\n".join(lines)}'}</pre>

              <h3>报错速查</h3>
              <ul>
                <li><b>第 N 行 …</b>：行号就是你代码的行号；KeyError 多半是输入变量键名对不上。</li>
                <li><b>返回了 list，需要 dict</b>：包一层 <code>{'return {"rows": 列表}'}</code>。</li>
                <li><b>ImportError</b>：包没预装，找管理员在「Python 依赖」页添加。</li>
                <li><b>执行超过 Ns</b>：调大超时或少拉数据 —— 能在 SQL 里聚合的别拉进来循环。</li>
                <li><b>沙箱不可用/未配置</b>：不是代码问题，找管理员。</li>
              </ul>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
