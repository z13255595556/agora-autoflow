/**
 * 快捷键的唯一清单。
 *
 * 在此之前十三组快捷键散在 Canvas.tsx / App.tsx / Inspector.tsx / RefField.tsx 四处，
 * 没有任何地方能看全 —— 用户只能从 README 或者某个 title 里偶然发现。
 * 这张表只负责「有哪些、怎么念」；绑定本身仍在各组件里（它们各有作用域判断），
 * 加绑定时记得来这里加一行，否则 ? 面板里就少一条。
 */
export interface Shortcut {
  /** 按键的显示写法。mod = ⌘（Mac）/ Ctrl */
  keys: string[]
  label: string
  scope: '画布' | '编辑' | '运行' | '输入框' | '全局'
}

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** 修饰键按平台念 —— 给 Windows 用户看 ⌘ 等于没说 */
export const MOD = IS_MAC ? '⌘' : 'Ctrl'

export const SHORTCUTS: Shortcut[] = [
  { keys: ['Tab'], label: '添加节点（接在选中节点后面）', scope: '画布' },
  { keys: ['双击空白'], label: '在指针处添加节点', scope: '画布' },
  { keys: ['双击节点'], label: '打开详情（输入 / 参数 / 输出）', scope: '画布' },
  { keys: ['Delete', 'Backspace'], label: '删除选中的节点或连线', scope: '画布' },
  { keys: [`${MOD}+C`, `${MOD}+V`], label: '复制 / 粘贴节点（连带选区内的连线）', scope: '画布' },
  { keys: [`${MOD}+D`], label: '创建副本', scope: '画布' },
  { keys: [`${MOD}+O`], label: '自动整理并适应画布', scope: '画布' },
  { keys: [`${MOD}+1`], label: '适应画布', scope: '画布' },
  { keys: ['Shift+1'], label: '缩放到 100%', scope: '画布' },
  { keys: [`${MOD}+=`, `${MOD}+-`], label: '放大 / 缩小', scope: '画布' },
  { keys: [`${MOD}+Z`, `${MOD}+Shift+Z`], label: '撤销 / 重做（最多 50 步）', scope: '编辑' },
  { keys: [`${MOD}+S`], label: '立即保存（平时 900ms 自动保存）', scope: '编辑' },
  { keys: [`${MOD}+Enter`], label: '运行当前选中的节点（上游用最近一次运行的数据）', scope: '运行' },
  { keys: ['/'], label: '在输入框里选上游数据（行首或空格后）', scope: '输入框' },
  { keys: ['单击胶囊', '双击胶囊'], label: '重新选数据 / 改成表达式', scope: '输入框' },
  { keys: [`${MOD}+K`], label: '命令栏：运行、加节点、流程设置、回首页', scope: '全局' },
  { keys: ['?'], label: '打开这张快捷键表', scope: '全局' },
  { keys: ['Esc'], label: '关闭弹层 / 收起选择器', scope: '全局' },
]

/** 按作用域分组，顺序固定 —— 面板上扫一眼就知道在哪能按 */
export function groupedShortcuts(): Array<{ scope: Shortcut['scope']; items: Shortcut[] }> {
  const order: Shortcut['scope'][] = ['画布', '编辑', '运行', '输入框', '全局']
  return order.map((scope) => ({ scope, items: SHORTCUTS.filter((s) => s.scope === scope) }))
}
