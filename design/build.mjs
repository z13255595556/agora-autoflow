// 从 src/styles.css 抽出的真实样式 + 复刻的界面片段，拼成 8 块 .dc.html 画板。
// 改设计改这个文件，跑 `node design/build.mjs` 重新生成画板。
import { readFileSync, writeFileSync } from 'node:fs'

const RAW = readFileSync(new URL('./app.css', import.meta.url), 'utf8')
// 注释里那对花括号会被模板引擎当成取值洞
// 注释先剥掉：留着既占体积，又会把 `10.5px` 这种字样混进选择器的 class 提取里
const APPCSS = RAW.replace(/\/\*[\s\S]*?\*\//g, '').replace('{{ }}', '「 」')

const W = 1440, H = 860

const PATH = {
  back: '<path d="M10 12.5 5.5 8 10 3.5"/>',
  play: '<g fill="currentColor" stroke="none"><path d="M4.5 3.2v9.6l8-4.8z"/></g>',
  help: '<path d="M8 14.2A6.2 6.2 0 1 0 8 1.8a6.2 6.2 0 0 0 0 12.4ZM6.2 6.3c.2-1 1-1.6 1.9-1.6 1 0 1.8.7 1.8 1.5 0 1.4-1.8 1.4-1.8 2.8M8 11.3h.01"/>',
  expand: '<path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/>',
  trash: '<path d="M2.8 4.4h10.4M6.4 4.4V3.2c0-.4.3-.7.7-.7h1.8c.4 0 .7.3.7.7v1.2M4.2 4.4l.5 8c0 .6.5 1.1 1.1 1.1h4.4c.6 0 1.1-.5 1.1-1.1l.5-8"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9"/>',
  minus: '<path d="M3.5 8h9"/>',
  more: '<circle cx="3.6" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="8" cy="8" r="1.15" fill="currentColor" stroke="none"/><circle cx="12.4" cy="8" r="1.15" fill="currentColor" stroke="none"/>',
  fit: '<path d="M2.5 5.8v-2a1.3 1.3 0 0 1 1.3-1.3h2M13.5 5.8v-2a1.3 1.3 0 0 0-1.3-1.3h-2M2.5 10.2v2a1.3 1.3 0 0 0 1.3 1.3h2M13.5 10.2v2a1.3 1.3 0 0 1-1.3 1.3h-2"/>',
  layout: '<path d="M2.5 8h3.5M10 4.2h3.5M10 11.8h3.5M6 8h1.4c.7 0 1.2-.5 1.4-1.1l.4-1.5c.2-.7.7-1.2 1.4-1.2M6 8h1.4c.7 0 1.2.5 1.4 1.1l.4 1.5c.2.7.7 1.2 1.4 1.2"/>',
  search: '<circle cx="7.2" cy="7.2" r="4.2"/><path d="M10.4 10.4 13.5 13.5"/>',
  hand: '<path d="M5.2 7V4.3c0-.6.4-1 .9-1s.9.4.9 1V7M7 6V3.5c0-.6.4-1 .9-1s.9.4.9 1V6M8.8 6V4c0-.6.4-1 .9-1s.9.4.9 1v3.5M10.6 6.5V5.3c0-.6.4-1 .9-1s.9.4.9 1v4c0 2.7-1.6 4.2-4.2 4.2-1.8 0-2.8-.7-3.8-2.2L2.4 9.6c-.3-.5-.1-1.1.4-1.4.4-.2.9-.1 1.2.2l1.2 1.2"/>',
  note: '<path d="M3 2.5h10v7.2l-3.8 3.8H3ZM9.2 13.5V9.7H13"/>',
  vars: '<path d="M6 2.8c-1.6.6-2.2 2-2 3.4.2 1-.3 1.5-1.2 1.8.9.3 1.4.8 1.2 1.8-.2 1.4.4 2.8 2 3.4M10 2.8c1.6.6 2.2 2 2 3.4-.2 1 .3 1.5 1.2 1.8-.9.3-1.4.8-1.2 1.8.2 1.4-.4 2.8-2 3.4"/>',
}
const ic = (n, s = 16) =>
  `<svg class="icon" width="${s}" height="${s}" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${PATH[n]}</svg>`

// ---------------------------------------------------------------- 顶栏 / 画布

const topbar = () => `
<header class="topbar">
  <button class="topbar__back" aria-label="返回">${ic('back')}</button>
  <div class="topbar__id">
    <input class="topbar__name" value="定时查询 SQL" readonly="readonly" aria-label="流程名">
    <div class="topbar__meta"><span>3 节点 · 2 连线</span><span class="savestate">已保存</span></div>
  </div>
  <div class="topbar__right">
    <span class="chip chip--ok"><i></i>已连接</span>
    <span class="chip chip--warn"><i></i>1 处待补</span>
    <button class="iconbtn" aria-label="更多">${ic('more')}</button>
    <button class="btn btn--primary">${ic('play', 14)} 运行</button>
  </div>
</header>`

const NODE_Y = 296
const node = ({ x, accent, icon, name, summary, extra = '', selected = false }) => `
<div class="node${selected ? ' node--selected' : ''}" style="--accent: ${accent}; position: absolute; left: ${x}px; top: ${NODE_Y}px;">
  <div class="node__head">
    <span class="node__icon">${icon}</span>
    <div class="node__titles">
      <div class="node__name">${name}</div>
      <div class="node__summary">${summary}</div>
    </div>
  </div>
  ${extra}
</div>`

const canvas = () => `
<div class="canvas" style="position: absolute; inset: 0; background-image: radial-gradient(circle, color-mix(in srgb, var(--text-faint) 45%, transparent) 1px, transparent 1px); background-size: 20px 20px;">
  <svg width="100%" height="100%" style="position: absolute; inset: 0;" aria-hidden="true">
    <path d="M300 327 C 340 327, 360 327, 400 327" fill="none" stroke="var(--border-strong)" stroke-width="1.8"/>
    <path d="M644 327 C 684 327, 704 327, 744 327" fill="none" stroke="var(--border-strong)" stroke-width="1.8"/>
  </svg>
  ${node({
    x: 56, accent: '#d97706', icon: '⏰', name: '每天 09:00', summary: '每天 09:00',
    extra: `<button class="node__swap">更换触发方式</button>
    <div class="node__warnline"><i>!</i>不会自动运行 —— 调度器没在跑</div>`,
  })}
  ${node({ x: 400, accent: '#2563eb', icon: '▤', name: 'DataLego SQL', summary: 'hive · dc_rate 日报' })}
  ${node({
    x: 744, accent: '#e11d48', icon: '✉', name: '企微通知', summary: 'markdown_v2 · 未填群机器人地址', selected: true,
    extra: `<div class="node__errline"><i>!</i>必填项「Webhook 地址」未填</div>
    <div class="node__ports"><div class="node__terminal">流程终点</div></div>`,
  })}
  <div class="canvasprimarytools" style="position: absolute; left: 14px; top: 14px;">
    <button class="canvasadd"><span>${ic('plus', 13)}</span> 添加节点</button>
    <button class="canvasfind" aria-label="命令栏">${ic('search', 15)}</button>
  </div>
  <div class="cctl" style="position: absolute; left: 14px; bottom: 14px;">
    <button class="cctl__btn cctl__btn--wide is-active">${ic('hand', 14)} 平移</button>
    <button class="cctl__btn cctl__btn--wide">${ic('note', 14)} 便签</button>
    <i class="cctl__sep"></i>
    <button class="cctl__btn">${ic('minus', 14)}</button>
    <button class="cctl__zoom">100%</button>
    <button class="cctl__btn">${ic('plus', 14)}</button>
    <i class="cctl__sep"></i>
    <button class="cctl__btn">${ic('fit', 14)}</button>
    <button class="cctl__btn cctl__btn--wide">${ic('layout', 14)} 整理</button>
  </div>
</div>`

// ---------------------------------------------------------------- 参数表单

/** 内容字段。active=画高亮环，ghost=在光标处画一枚待插入的虚线胶囊 */
const paramsForm = ({ active = '', ghost = '', openAttr = '' } = {}) => `
<div class="form">
  <div class="field">
    <div class="field__label">Webhook 地址 <span class="req">*</span></div>
    <div class="field__desc">群设置 → 群机器人 → 添加后复制。等同凭证，流程定义要当凭证管</div>
    <input placeholder="https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx" aria-label="Webhook 地址">
    <div class="field__errors">必填项「Webhook 地址」未填</div>
  </div>
  <div class="field">
    <div class="field__label">消息类型 <span class="req">*</span></div>
    <div class="field__desc">要发表格必须用 markdown_v2；要 @人只能用 text 或 markdown</div>
    <select aria-label="消息类型"><option>markdown_v2</option></select>
  </div>
  <div class="nx-anchor">
    <div class="field${active ? ' ' + active : ''}">
      <div class="field__label">内容 <span class="req">*</span></div>
      <div class="field__desc">点下面的「从上游取值」把查询结果放进来</div>
      <div class="reffield reffield--multi" style="min-height: 96px;"${openAttr}>查询完成，共 <span class="rchip rchip--ok">DataLe…·返回行数</span> 条<br><br><span class="rchip rchip--ok">DataLe…·整张表格</span>${ghost || ''}<i class="nx-caret"></i></div>
      <button class="tpick__cta"${openAttr}>
        <span class="tpick__cta-icon">${ic('vars', 15)}</span>
        <span class="tpick__cta-text"><b>从上游取值</b><em>打「/」或点这里，从上游节点的结果里选</em></span>
      </button>
    </div>
    __POPOVER__
  </div>
  <div class="mprev">
    <div class="mprev__head">预览 <em>就是会发出去的内容</em><span class="mprev__bytes">61 / 4096 字节</span></div>
    <pre class="mono prewrap mprev__body">查询完成，共 3 条

| dt | platform | sessions | dc_rate |
| --- | --- | --- | --- |
| 2026-08-24 | Android | 128394 | 0.42 |</pre>
    <div class="mprev__live">⚡ 点「运行」就会真的发到群里，先在上面确认内容</div>
  </div>
</div>`

const insrun = () => `
<div class="insrun">
  <span class="insrun__state"><i></i>尚未运行</span>
  <button class="btn btn--primary">${ic('play', 14)} 运行本节点</button>
</div>`

const nodeHead = (tools) => `
<div class="dock__head dock__head--node">
  <span class="ins__icon" style="background: #e11d48;">✉</span>
  <div class="ins__title">
    <input class="ins__name" value="企微通知" readonly="readonly" aria-label="节点名">
    <div class="ins__meta"><span>企微通知</span></div>
  </div>
  ${tools}
</div>`

const HEAD_TOOLS = `<button class="iconbtn" aria-label="帮助">${ic('help')}</button>
  <button class="iconbtn" aria-label="放大">${ic('expand')}</button>
  <button class="iconbtn iconbtn--danger" aria-label="删除">${ic('trash')}</button>
  <button class="iconbtn" aria-label="关闭">${ic('close')}</button>`

// ---------------------------------------------------------------- 取值面板内容

const COLS = ['dt', 'platform', 'sessions', 'dc_rate']
const ROWS = [
  ['2026-08-24', 'Android', '128394', '0.42'],
  ['2026-08-24', 'iOS', '96221', '0.31'],
  ['2026-08-24', 'Web', '41077', '0.58'],
  ['2026-08-23', 'Android', '124018', '0.44'],
  ['2026-08-23', 'iOS', '93760', '0.29'],
  ['2026-08-23', 'Web', '39642', '0.61'],
]

const pickerSearch = () => `
<div class="dataref__search"><input placeholder="搜索节点或字段" aria-label="搜索节点或字段"></div>`

const pickerList = () => `
<section class="dataref__section">
  <h3>流程数据</h3>
  <button class="dataref__row"><span><strong>运行 ID</strong><small>运行上下文</small></span><em>string</em></button>
  <button class="dataref__row"><span><strong>开始时间</strong><small>运行上下文</small></span><em>string</em></button>
  <button class="dataref__fold"><span><strong>时间函数</strong><small>9 个可用值</small></span><b>+</b></button>
</section>
<section class="dataref__section">
  <h3>上游节点</h3>
  <button class="dataref__source"><span class="dataref__source-icon">SQL</span><span><strong>DataLego SQL</strong><small>已有真实运行结果</small></span><b>›</b></button>
  <button class="dataref__source"><span class="dataref__source-icon">OUT</span><span><strong>每天 09:00</strong><small>已有字段结构</small></span><b>›</b></button>
</section>`

/** 钻进 DataLego SQL 的结果表。modeCols=模式按钮排几列（现状是 5 列 6 个按钮，会折行） */
const pickerTable = ({ modeCols = 6, nRows = 3 } = {}) => `
<button class="dataref__back">‹ 返回节点列表</button>
<div class="dataref__crumb">DataLego SQL</div>
<div class="dataref__fresh">实际结果 · 09:00</div>
<div class="dataref__modes" style="grid-template-columns: repeat(${modeCols}, minmax(0, 1fr));">
  <button class="is-on">单个值</button><button>整行</button><button>整列</button>
  <button>表格</button><button>汇总</button><button>按条件</button>
</div>
<div class="dataref__nth"><label>指定行 <input type="number" value="1" aria-label="指定行"></label><span>点击下方单元格或列名</span></div>
<div class="dataref__tablewrap">
  <table class="dataref__table">
    <thead><tr><th>#</th>${COLS.map((c) => `<th><button>${c}</button></th>`).join('')}</tr></thead>
    <tbody>${ROWS.slice(0, nRows).map((r, i) => `<tr><th><button>${i + 1}</button></th>${r.map((v, j) => `<td><button${i === 0 && j === 3 ? ' style="background: var(--primary-soft); color: var(--primary); font-weight: 600;"' : ''}>${v}</button></td>`).join('')}</tr>`).join('')}</tbody>
  </table>
</div>
<div class="dataref__tableactions"><button>完整结果</button><button>结果数量</button></div>`

const pickerFooter = () => `
<footer class="nx-foot">
  <div class="nx-foot__main">
    <span>将插入到「内容」光标处</span>
    <div><strong>dc_rate · 第 1 行</strong><em>0.42</em></div>
  </div>
  <button class="btn btn--primary">插入变量</button>
</footer>`

// ---------------------------------------------------------------- NDV 三/四栏

const ndvHead = () => `
<div class="ndv__head">
  <span class="ins__icon" style="background: #e11d48;">✉</span>
  <span class="ndv__title">企微通知</span>
  <button class="btn">${ic('play', 14)} 试运行本节点</button>
  <button class="btn">关闭</button>
</div>`

const ndvOutput = (basis) => `
<section class="ndv__col ndv__col--output" style="flex: 0 0 ${basis};">
  <div class="ndv__coltitle">输出<span class="ndv__tools"><button class="on">表格</button><button>JSON</button></span></div>
  <div class="ndv__colbody">
    <div class="empty">还没有输出数据</div>
    <div class="ndv__pinbar"><span class="ndv__meta">多出口/无出口节点不支持固定输出</span></div>
  </div>
</section>`

const ndvInput = (basis) => `
<section class="ndv__col ndv__col--input" style="flex: 0 0 ${basis};">
  <div class="ndv__coltitle">输入</div>
  <div class="ndv__colbody">
    <div class="ndv__sec">解析后入参 <em>服务实际收到的</em></div>
    <div class="empty">还没运行过。运行整条流程，或点上方「试运行本节点」。</div>
    <div class="ndv__sec">上游输出</div>
    <details class="ndv__upstream"><summary>DataLego SQL <code>n2</code></summary></details>
  </div>
</section>`

/** 方案 C：输入栏直接就是取值栏 */
const ndvInputPick = (basis) => `
<section class="ndv__col ndv__col--input" style="flex: 0 0 ${basis};">
  <div class="ndv__coltitle">输入 · 点任意值即插入</div>
  <div class="nx-target">插入到 <strong>内容</strong><em>光标处</em></div>
  <div class="ndv__colbody">
    <div class="ndv__sec">DataLego SQL <em>实际结果 · 09:00 · 3 行</em></div>
    ${pickerTable({ modeCols: 3 })}
  </div>
  ${pickerFooter()}
</section>`

const ndvParams = ({ basis = '1', dynamic = true } = {}) => `
<section class="ndv__col ndv__col--params" style="flex: ${basis};">
  <div class="ndv__coltitle">参数</div>
  <div class="ndv__colbody">__FORM__</div>
</section>`

// ---------------------------------------------------------------- 新样式

const NXCSS = `
/* —— 画板底座 —— */
html, body { height: 100%; margin: 0; overflow: hidden; }
.app { position: relative; width: ${W}px; height: ${H}px; overflow: hidden; }
/* 画板里没有真正的视口：固定定位改成相对 .app，数值不变 */
.dataref, .ndv__mask { position: absolute; }
/* 尾部那条 order:-1 在这里不需要 —— DOM 直接按视觉顺序写 */
.ndv__col--output { order: 0; }
a { color: var(--primary); }
a:hover { color: var(--primary-hover); }

/* —— 新设计：取值栏是编辑器的一栏 —— */
.nx-anchor { position: relative; }
.nx-field-active {
  margin: -8px -10px; padding: 8px 10px; border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--primary) 7%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent);
}
.nx-ghost {
  display: inline-block; margin: 0 1px; padding: 0 5px;
  border: 1px dashed var(--primary); border-radius: var(--r-sm);
  background: var(--primary-soft); color: var(--primary);
  font-size: 11px; line-height: 1.5;
}
.nx-caret { display: inline-block; width: 1.5px; height: 15px; margin-left: 1px; vertical-align: -3px; background: var(--primary); }
.nx-pane { display: flex; flex-direction: column; min-width: 0; min-height: 0; background: var(--surface-2); }
.nx-pane__head { flex: none; min-height: 58px; display: flex; align-items: center; gap: 9px; padding: 0 8px 0 14px; border-bottom: 1px solid var(--border); }
.nx-pane__head strong { font-size: 13px; font-weight: 600; }
.nx-for { display: inline-flex; align-items: center; gap: 5px; padding: 2px 9px; border-radius: 20px; background: var(--primary-soft); color: var(--primary); font-size: 11px; font-weight: 500; }
.nx-pane__head .iconbtn { margin-left: auto; }
.nx-pane__body { flex: 1; min-width: 0; min-height: 0; overflow: auto; padding: 12px 14px 14px; }
.nx-foot {
  flex: none; display: grid; grid-template-columns: minmax(0, 1fr) auto;
  align-items: center; gap: 12px; padding: 11px 14px;
  border-top: 1px solid var(--border); background: var(--surface);
}
.nx-foot__main { min-width: 0; display: grid; gap: 1px; }
.nx-foot__main > span { color: var(--text-faint); font-size: 9.5px; }
.nx-foot__main > div { min-width: 0; display: flex; align-items: baseline; gap: 8px; }
.nx-foot__main strong { overflow: hidden; font-size: 11.5px; font-weight: 600; text-overflow: ellipsis; white-space: nowrap; }
.nx-foot__main em { flex: none; color: var(--primary); font: normal 11px var(--mono); }

/* 弹窗里的取值栏，栏头要和其他三栏的标题严丝合缝 */
.ndv__col--pick .nx-pane__head { min-height: 42px; padding: 0 6px 0 13px; }
.ndv__col--pick .nx-pane__head strong { color: var(--text-faint); font-size: 11px; text-transform: uppercase; letter-spacing: .5px; }

/* 侧栏：同一张卡横向长出一栏 */
.dock--pair { flex-direction: row; transition: width .2s ease; }
.nx-split { flex: none; width: 1px; background: var(--border); }
.nx-col-params { flex: none; width: 398px; display: flex; flex-direction: column; min-height: 0; background: var(--surface); }

/* 放大：弹窗自己变宽，多出一栏 */
.ndv { transition: width .2s ease; }
.ndv__col--pick { border-right: 1px solid var(--border); }

/* ---------------------------------------------------------------- 抽屉
 *
 * 三条规矩，缺一条就不像抽屉：
 * 1. 参数栏钉死在右边 —— 卡片的 right 不动、只动 width，所以正在填的字段
 *    整个过程一个像素都不挪。抽屉是从它左边被拉出来的。
 * 2. 抽屉里的内容宽度是**定死的**，靠外层裁切露出来。跟着宽度排版的话，
 *    文字每一帧都在重排，那是"面板在长大"，不是"抽屉被拉出来"。
 * 3. 拉和收用不同的曲线：拉出减速（有重量地停住），收回加速（干脆离开）。
 */
.nx-drawer-host { flex-direction: row; width: 400px; transition: width 180ms cubic-bezier(.4, 0, 1, 1); }
.nx-drawer-host.is-open { width: 908px; transition: width 240ms cubic-bezier(.16, 1, .3, 1); }
.nx-drawer { flex: 1 1 auto; min-width: 0; display: flex; overflow: hidden; }
.nx-drawer__inner {
  flex: none; width: 507px; display: flex; flex-direction: column; min-height: 0;
  background: var(--surface-2); border-right: 1px solid var(--border);
  transform: translateX(-18px);
  transition: transform 180ms cubic-bezier(.4, 0, 1, 1);
}
.is-open .nx-drawer__inner { transform: none; transition: transform 240ms cubic-bezier(.16, 1, .3, 1); }
.nx-col-params { flex: none; width: 398px; display: flex; flex-direction: column; min-height: 0; background: var(--surface); }

/* 放大态：弹窗自己变宽，取值栏从「参数」左边拉出来 */
.ndv { width: 1180px; transition: width 180ms cubic-bezier(.4, 0, 1, 1); }
.ndv.is-open { width: 1300px; transition: width 240ms cubic-bezier(.16, 1, .3, 1); }
.ndv__col { transition: flex-basis 180ms cubic-bezier(.4, 0, 1, 1); }
.ndv.is-open .ndv__col { transition: flex-basis 240ms cubic-bezier(.16, 1, .3, 1); }
.ndv__col--pick { flex: 0 0 0; min-width: 0; overflow: hidden; }
.ndv.is-open .ndv__col--pick { flex-basis: 400px; }
.ndv__col--pick > .nx-drawer__inner { flex: 1 1 auto; width: 399px; }

/* 高亮环跟着抽屉一起亮起来，晚一点点 —— 视线先跟抽屉走 */
.nx-field { transition: background 200ms ease, box-shadow 200ms ease; }
.nx-field-active {
  margin: -8px -10px; padding: 8px 10px; border-radius: var(--r-lg);
  background: color-mix(in srgb, var(--primary) 7%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 38%, transparent);
  transition-delay: 60ms;
}
/* 待插入的胶囊：抽屉拉到一半时才冒出来 */
.nx-ghost {
  display: inline-block; max-width: 0; margin: 0; padding: 0; overflow: hidden;
  border: 0 dashed var(--primary); border-radius: var(--r-sm);
  background: var(--primary-soft); color: var(--primary);
  font-size: 11px; line-height: 1.5; white-space: nowrap; opacity: 0;
  transition: max-width 160ms ease, opacity 120ms ease, padding 160ms ease;
}
.nx-ghost.is-in {
  max-width: 190px; margin: 0 1px; padding: 0 5px; border-width: 1px; opacity: 1;
  transition-delay: 110ms;
}

/* 说了不要动画的人，就别给他动画 */
@media (prefers-reduced-motion: reduce) {
  .nx-drawer-host, .nx-drawer-host.is-open, .nx-drawer__inner,
  .is-open .nx-drawer__inner, .ndv, .ndv.is-open,
  .ndv__col, .ndv.is-open .ndv__col, .nx-field, .nx-ghost {
    transition-duration: 0ms !important;
  }
}

/* 动效规格页 */
.spec { padding: 44px 52px; display: flex; flex-direction: column; gap: 26px; }
.spec h1 { margin: 0; font-size: 26px; font-weight: 650; letter-spacing: -.2px; }
.spec__lead { margin: 0; max-width: 62ch; color: var(--text-dim); font-size: 13.5px; line-height: 1.85; }
.spec__grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 14px; }
.spec__card { padding: 18px 20px; border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--surface); }
.spec__card h2 { margin: 0 0 4px; font-size: 13px; font-weight: 650; }
.spec__card p { margin: 0; color: var(--text-dim); font-size: 12px; line-height: 1.8; }
.spec__curve { display: flex; align-items: center; gap: 14px; margin-bottom: 10px; }
.spec__curve code { color: var(--primary); font: 11px var(--mono); }
.spec__ms { margin-left: auto; color: var(--text-faint); font: 11px var(--mono); }
.spec__demo { display: flex; align-items: flex-start; gap: 18px; }
.spec__stage {
  position: relative; width: 520px; height: 168px; flex: none; overflow: hidden;
  border: 1px solid var(--border); border-radius: var(--r-lg); background: var(--bg);
}
.spec__note { color: var(--text-faint); font-size: 11.5px; line-height: 1.8; }
.spec__note b { color: var(--text-dim); font-weight: 600; }
`

// ---------------------------------------------------------------- 画板骨架

const OPEN = ' onClick="{{ openIt }}"'
const CLOSE = ' onClick="{{ closeIt }}"'
const TOGGLE = ' onClick="{{ toggle }}"'
const IF = (cond, html) => `<sc-if value="{{ ${cond} }}" hint-placeholder-val="{{ true }}">${html}</sc-if>`
const GHOST = '<span class="nx-ghost">dc_rate · 第 1 行</span>'
const form = (opts, popover = '') => paramsForm(opts).replace('__POPOVER__', popover)


// ---------------------------------------------------------------- 只留用得上的样式
// 每块画板都自带一份完整的 app.css 的话，八份加起来 600KB 全是死规则。
// 按画板里真实出现过的 class 过一遍，剩下的丢掉。

function usedClasses(html) {
  const set = new Set(['nx-field-active', 'is-on', 'is-active', 'node--selected', 'iconbtn--danger'])
  // 取值洞不是 class：`class="field {{ activeCls }}"` 里那个名字先剔掉
  html = html.replace(/\{\{[^}]*\}\}/g, '')
  for (const m of html.matchAll(/class="([^"]*)"/g)) {
    for (const token of m[1].split(/\s+/)) if (/^[-\w]+$/.test(token)) set.add(token)
  }
  return set
}

/** 把 CSS 切成顶层的 `选择器 { … }` 块 */
function blocks(css) {
  const out = []
  let depth = 0, start = 0
  for (let i = 0; i < css.length; i++) {
    const ch = css[i]
    if (ch === '{') { if (depth === 0) out.push({ sel: css.slice(start, i) }); depth++ }
    else if (ch === '}') {
      depth--
      if (depth === 0) { out[out.length - 1].body = css.slice(css.indexOf('{', start) + 1, i); start = i + 1 }
    }
  }
  return out
}

function prune(css, used) {
  return blocks(css).map(({ sel, body }) => {
    const head = sel.trim()
    if (body === undefined) return ''
    if (head.startsWith('@keyframes') || head.startsWith('@font-face')) return `${head} {${body}}`
    if (head.startsWith('@')) {
      const inner = prune(body, used)
      return inner.trim() ? `${head} {\n${inner}\n}` : ''
    }
    const kept = head.split(',').map((s) => s.trim()).filter((one) => {
      const classes = [...one.matchAll(/\.([-\w]+)/g)].map((m) => m[1])
      return classes.every((c) => used.has(c))
    })
    return kept.length ? `${kept.join(', ')} {${body}}` : ''
  }).filter(Boolean).join('\n')
}

const artboard = ({ body, extraCss = '' }) => `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <script src="./support.js"></script>
</head>
<body>
<x-dc>
<helmet>
  <style>
${prune(APPCSS, usedClasses(body))}
${NXCSS}
${extraCss}
  </style>
</helmet>
${body}
</x-dc>
<script data-dc-script data-props='{"$preview":{"width":${W},"height":${H}}}'>
class Component extends DCLogic {
  constructor(props) {
    super(props)
    this.state = { open: false }
  }
  renderVals() {
    const open = !!this.state.open
    return {
      open,
      closed: !open,
      activeCls: open ? 'nx-field-active' : '',
      outW: open ? '280px' : '400px',
      inW: open ? '220px' : '300px',
      openCls: open ? 'is-open' : '',
      ghostCls: open ? 'is-in' : '',
      toggle: () => this.setState({ open: !open }),
      openIt: () => this.setState({ open: true }),
      closeIt: () => this.setState({ open: false }),
    }
  }
}
</script>
</body>
</html>
`

const stage = (stageOverlays, appOverlays = '') => `
<div class="app">
  ${topbar()}
  <div class="app__main"><div class="app__stage">
    ${canvas()}
    ${stageOverlays}
  </div></div>
  ${appOverlays}
</div>`


// ================================================================ 方案 A：并栏抽屉

const PANE = () => `
      <div class="nx-drawer__inner">
        <div class="nx-pane__head">
          <strong>取值</strong>
          <span class="nx-for">为「内容」</span>
          <button class="iconbtn"${CLOSE} aria-label="收起取值栏">${ic('close')}</button>
        </div>
        ${pickerSearch()}
        <div class="nx-pane__body">${pickerTable({ nRows: 6 })}</div>
        ${pickerFooter()}
      </div>`

const A_FORM = form({
  active: 'nx-field {{ activeCls }}',
  ghost: '<span class="nx-ghost {{ ghostCls }}">dc_rate · 第 1 行</span>',
  openAttr: OPEN,
})

const A_DOCK = stage(`
    <aside class="dock nx-drawer-host {{ openCls }}">
      <div class="nx-drawer">${PANE()}</div>
      <div class="nx-col-params">
        ${nodeHead(HEAD_TOOLS)}
        <div class="dock__body">${A_FORM}</div>
        ${insrun()}
      </div>
    </aside>`)

const A_BIG = stage('', `
    <div class="ndv__mask">
      <div class="ndv {{ openCls }}">
        ${ndvHead()}
        <div class="ndv__cols">
          ${ndvOutput('{{ outW }}')}
          ${ndvInput('{{ inW }}')}
          <section class="ndv__col ndv__col--pick">${PANE()}</section>
          ${ndvParams().replace('__FORM__', A_FORM)}
        </div>
      </div>
    </div>`)

// ================================================================ 动效规格

const curve = (d, label) => `
<svg width="52" height="52" viewBox="0 0 52 52" fill="none" aria-hidden="true">
  <rect x="1" y="1" width="50" height="50" rx="7" stroke="var(--border)"/>
  <path d="${d}" stroke="var(--primary)" stroke-width="1.8" stroke-linecap="round"/>
  <title>${label}</title>
</svg>`

const MOTION = `
<div class="app">
  <div class="spec">
    <div>
      <h1>抽屉动效</h1>
      <p class="spec__lead">取值栏不是"弹出来的面板"，是从编辑器右半边<b>拉出来</b>的一层。下面这四条决定了它像不像抽屉 —— 少任何一条，它就退回成"面板在长大"。</p>
    </div>

    <div class="spec__demo">
      <div class="spec__stage">
        <div class="demo {{ openCls }}">
          <div class="demo__drawer"><div class="demo__inner">
            <span class="demo__bar" style="width: 54%"></span>
            <span class="demo__bar" style="width: 78%"></span>
            <span class="demo__bar" style="width: 41%"></span>
            <span class="demo__bar" style="width: 66%"></span>
          </div></div>
          <div class="demo__params">
            <span class="demo__bar demo__bar--dark" style="width: 62%"></span>
            <span class="demo__field {{ activeCls }}"></span>
            <span class="demo__bar demo__bar--dark" style="width: 47%"></span>
          </div>
        </div>
      </div>
      <div>
        <button class="btn btn--primary"${TOGGLE}>拉出 / 收回</button>
        <p class="spec__note" style="margin-top: 12px;">按一下看真实时长。<br>右边那块（参数栏）<b>一个像素都不动</b> —— 抽屉是从它左边被拉出来的。</p>
      </div>
    </div>

    <div class="spec__grid">
      <div class="spec__card">
        <div class="spec__curve">
          ${curve('M6 46 C 14 46, 20 8, 46 6', '减速')}
          <div><code>cubic-bezier(.16, 1, .3, 1)</code><div class="spec__note">拉出：起手快，末尾轻轻停住 —— 有重量</div></div>
          <span class="spec__ms">240ms</span>
        </div>
        <h2>拉出</h2>
        <p>卡片 <code>width</code> 400 → 908。<code>right</code> 不动，所以是往左长。</p>
      </div>

      <div class="spec__card">
        <div class="spec__curve">
          ${curve('M6 46 C 30 44, 40 30, 46 6', '加速')}
          <div><code>cubic-bezier(.4, 0, 1, 1)</code><div class="spec__note">收回：一路加速，干脆离开</div></div>
          <span class="spec__ms">180ms</span>
        </div>
        <h2>收回</h2>
        <p>比拉出快 60ms。收东西不该让人等 —— 拉和收同一条曲线就会显得黏。</p>
      </div>

      <div class="spec__card">
        <h2>抽屉里的内容不跟着变宽</h2>
        <p>里层宽度写死 507px，靠外层 <code>overflow: hidden</code> 裁出来。跟着容器宽度排版的话，文字每一帧都在重排 —— 那是面板在长大，不是抽屉被拉出来。另外里层同时从 <code>translateX(-18px)</code> 归位，像被拽出来而不是被揭开。</p>
      </div>

      <div class="spec__card">
        <h2>什么不动</h2>
        <p>侧栏态里参数表单、节点标题栏、底部运行条<b>全程零位移</b>（参数栏取 398 而不是 400 —— 卡片 400 里有 2px 边框，差这 2px 拉出的瞬间就会抖一下）。放大态弹窗居中变宽，两边各让 60px，是协调地长大而不是零位移。字段的高亮环晚 60ms 亮起，待插入的胶囊晚 110ms 冒出来 —— 视线先跟着抽屉走，再落到字段上。<br><br>另：<code>prefers-reduced-motion</code> 下全部 0ms，直接到位。</p>
      </div>
    </div>
  </div>
</div>`

const MOTION_CSS = `
.demo { position: absolute; inset: 0 0 0 auto; display: flex; width: 190px; overflow: hidden;
  border-left: 1px solid var(--border); background: var(--surface);
  transition: width 180ms cubic-bezier(.4, 0, 1, 1); }
.demo.is-open { width: 430px; transition: width 240ms cubic-bezier(.16, 1, .3, 1); }
.demo__drawer { flex: 1 1 auto; min-width: 0; display: flex; overflow: hidden; }
.demo__inner { flex: none; width: 239px; display: flex; flex-direction: column; gap: 11px;
  padding: 18px 16px; background: var(--surface-2); border-right: 1px solid var(--border);
  transform: translateX(-18px); transition: transform 180ms cubic-bezier(.4, 0, 1, 1); }
.demo.is-open .demo__inner { transform: none; transition: transform 240ms cubic-bezier(.16, 1, .3, 1); }
.demo__params { flex: none; width: 190px; display: flex; flex-direction: column; gap: 11px; padding: 18px 16px; }
.demo__bar { height: 7px; border-radius: 4px; background: var(--border-strong); }
.demo__bar--dark { background: var(--surface-3); }
.demo__field { height: 34px; border-radius: var(--r-sm); background: var(--surface-3);
  transition: background 200ms ease, box-shadow 200ms ease; }
.demo__field.nx-field-active { margin: 0; padding: 0;
  background: color-mix(in srgb, var(--primary) 12%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--primary) 45%, transparent); transition-delay: 60ms; }
@media (prefers-reduced-motion: reduce) {
  .demo, .demo.is-open, .demo__inner, .demo.is-open .demo__inner, .demo__field { transition-duration: 0ms !important; }
}`

// ================================================================ 输出

const BOARDS = [
  ['Main', A_DOCK, ''],
  ['Big', A_BIG, ''],
  ['Motion', MOTION, MOTION_CSS],
]

for (const [name, body, extraCss] of BOARDS) {
  const html = artboard({ body, extraCss })
  writeFileSync(new URL(`./${name}.dc.html`, import.meta.url), html)
  const css = html.match(/<style>([\s\S]*?)<\/style>/)[1]
  const orphans = [...usedClasses(body)].filter((c) => body.includes(c)).filter((c) => !css.includes(`.${c}`) && !NXCSS.includes(`.${c}`) && !extraCss.includes(`.${c}`))
  if (orphans.length) console.warn(`  ! ${name}: 没有样式的 class → ${orphans.join(' ')}`)
}
console.log(`wrote ${BOARDS.length} artboards`)

// ---------------------------------------------------------------- 画布布局

const TITLES = { Main: 'A 并栏 · 侧栏态', Big: 'A 并栏 · 放大态', Motion: '抽屉动效规格' }
const PLACE = { Main: [0, 0], Big: [1560, 0], Motion: [780, 990] }

const notes = [
  ['brief', 0, -300, 1000, `取值栏 × 节点编辑页 —— 方案 A：并栏抽屉

取值栏不是另一个面板，是编辑器自己长出来的一栏。同一张卡、同一层阴影、同一个圆角，中间只有一道 1px。

两块界面板都能点：点「内容」输入框，或它下面的「从上游取值」—— 抽屉拉出来；点抽屉右上角的 ✕ —— 收回去。停的这一刻是同一件事：正在填「内容」，要从上游 DataLego SQL 的结果里取 dc_rate 第 1 行。

界面照 src/styles.css 复刻，颜色字号圆角控件高度都取的真实变量。`],
  ['dock', -540, 40, 460, `侧栏态：卡片往左长

400 → 908。卡片的 right 钉在 12px 不动，只动 width —— 所以参数栏整个过程一个像素都不挪，抽屉是从它左边被拉出来的。

正在填的字段套上高亮环（晚 60ms），光标处冒出一枚待插入的虚线胶囊（晚 110ms）。底下那条说清楚插到哪、插进去是什么值。`],
  ['big', 1560 - 540, 40, 460, `放大态：弹窗自己变宽，谁也不盖谁

1180 → 1300。取值栏从「参数」左边拉出来，输出 400→280、输入 300→220 同步让位，参数 480→400（和侧栏同宽）。

现状那个「面板从弹窗上下两头戳出去、把输入栏盖死」的问题，在这里从构造上就不存在了 —— 取值栏是弹窗里的一栏，不是浮在它上面的东西。`],
  ['motion', 780 - 540, 1030, 460, `动效规格

给实现用的。四条规矩、两条曲线、什么不动，都在这块板上，中间那个小方块能真按下去看时长。

最容易做错的是第三条：抽屉里的内容宽度要写死、靠外层裁切露出来。跟着容器宽度排版的话文字每帧重排，看起来就是"面板在长大"，不是"抽屉被拉出来"。`],
]

writeFileSync(new URL('./canvas.json', import.meta.url), JSON.stringify({
  artboards: BOARDS.map(([name]) => {
    const [x, y] = PLACE[name]
    return { file: `${name}.dc.html`, title: TITLES[name], x, y, w: W, h: H }
  }),
  annotations: notes.map(([id, x, y, w, text]) => ({ id, x, y, w, text })),
  launch: { view: 'canvas' },
}, null, 2))
console.log('wrote canvas.json')
