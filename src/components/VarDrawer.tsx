import { useMemo, useState } from 'react'
import { useFlow } from '../store'
import { allVars } from '../lib/vars'
import { previewFromRun } from '../lib/engine'
import Icon from './Icon'

/**
 * 顶部「变量」面板：整条流程能用的引用，一处列全，点一下复制。
 *
 * 和字段旁边那个 { } 选择器分工不同 —— 那个是"插到光标处"，只列当前节点的上游；
 * 这个是通讯录，把所有节点的输出都摊开供查阅，方便一边看一边往 SQL / 消息里粘。
 * 所以这里**不做插入**，只复制。
 *
 * 一直挂载着，靠 open 切 CSS 类来收放：面板的宽度是**过渡**出来的，旁边的
 * 右栏和画布才会跟着一起平移。挂载/卸载的话宽度是瞬间的，只有自己在滑、
 * 别人在跳。
 */
export default function VarDrawer({
  open,
  shifted,
  onClose,
}: {
  open: boolean
  /** 右侧停靠区正开着 —— 变量栏要往左让出那一栏的宽度，不能互相压 */
  shifted: boolean
  onClose: () => void
}) {
  const nodes = useFlow((s) => s.nodes)
  const edges = useFlow((s) => s.edges)
  const flowInputs = useFlow((s) => s.flowInputs)
  const runs = useFlow((s) => s.runs)
  const activeRunId = useFlow((s) => s.activeRunId)
  const select = useFlow((s) => s.select)
  useFlow((s) => s.registryVersion)

  const [q, setQ] = useState('')
  const [copied, setCopied] = useState<string | null>(null)

  const activeRun = runs.find((r) => r.id === activeRunId) ?? runs[0] ?? null
  const preview = useMemo(() => previewFromRun(activeRun), [activeRun])

  const groups = useMemo(() => {
    const kw = q.trim().toLowerCase()
    const hit = allVars(nodes, edges, flowInputs).filter(
      (v) => !kw || v.path.toLowerCase().includes(kw) || v.label.toLowerCase().includes(kw),
    )
    const map = new Map<string, typeof hit>()
    for (const v of hit) map.set(v.group, [...(map.get(v.group) ?? []), v])
    return [...map.entries()]
  }, [q, nodes, edges, flowInputs])

  const copy = (path: string) => {
    // 复制成能直接粘进字段的形态，而不是裸路径 —— 少了 {{ }} 粘进去就是一段字面量
    void navigator.clipboard?.writeText(`{{ ${path} }}`).catch(() => {})
    setCopied(path)
  }

  return (
    // 独立的一栏，浮在节点配置面板左边，不顶掉它 ——
    // 变量表是"照着抄"的东西，抄的时候得能同时看见正在配的字段
    <aside
      className={`dock dock--vars${open ? ' is-open' : ''}${shifted ? ' is-shifted' : ''}`}
      aria-hidden={!open}
    >
      {/* 内层固定宽：外层位置在动的时候，文字不能跟着重排 */}
      <div className="vars__inner">
        <div className="dock__head">
          <span className="dock__title">变量</span>
          <i className="dock__sep" />
          <button className="iconbtn" onClick={onClose} title="收起变量面板">
            <Icon name="close" />
          </button>
        </div>

        <div className="dock__note">
          点任意一条复制为 <code>{'{{ … }}'}</code>，可粘进 SQL、消息内容等任意输入框。
          节点字段仅<b>下游</b>可引用；运行过一次后显示实际值。
        </div>

        <div className="dock__search">
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜索变量 / 日期函数…" />
        </div>

        <div className="vardrawer">
          {groups.map(([group, items]) => (
            <div className="vardrawer__group" key={group}>
              <div className="vardrawer__gtitle">
                {group}
                {/* 组名形如 "SQL 查询 (n2)"，点一下跳到那个节点 */}
                {group.match(/\((n\d+)\)$/) && (
                  <button className="linkbtn" onClick={() => select(group.match(/\((n\d+)\)$/)![1])}>
                    定位
                  </button>
                )}
              </div>
              {items.map((v) => {
                const val = preview?.(v.path)
                return (
                  // 一行两层：面板只有 320 宽，名字和路径挤一行两边都会被截成"昨天 202…"
                  <button
                    key={v.path}
                    className="vardrawer__row"
                    title={`复制 {{ ${v.path} }}`}
                    onClick={() => copy(v.path)}
                  >
                    <span className="vardrawer__top">
                      <span className="vardrawer__label">{v.label}</span>
                      <span className="vardrawer__type">{v.type}</span>
                      <span className="vardrawer__copy">{copied === v.path ? '已复制' : '复制'}</span>
                    </span>
                    <span className="vardrawer__bottom">
                      <code className="vardrawer__path">{v.path}</code>
                      {val?.found && <span className="vardrawer__val">→ {previewText(val.value)}</span>}
                    </span>
                  </button>
                )
              })}
            </div>
          ))}
          {groups.length === 0 && <div className="empty">没有匹配的变量</div>}
        </div>
      </div>
    </aside>
  )
}

function previewText(v: unknown): string {
  if (Array.isArray(v)) return `[${v.length} 项]`
  if (v !== null && typeof v === 'object') return '{…}'
  const s = String(v)
  return s.length > 20 ? `${s.slice(0, 20)}…` : s
}
