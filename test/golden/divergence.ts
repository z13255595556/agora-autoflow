/**
 * 新旧引擎**已知且有意**的行为差异。
 *
 * 这是一张白名单：golden 对比时，白名单之外的任何差异判红，
 * **登记了但实际没发生的差异也判红** —— 否则改回去之后这张表就成了谎言。
 *
 * 每条都必须写清"为什么这个方向是对的"。没有理由的差异不是差异，是 bug。
 */

export interface Divergence {
  /** 哪份用例 */
  fixture: string
  /** 差在哪 */
  what: string
  /** executeFlow 今天的行为 */
  before: string
  /** decide 模型的行为 */
  after: string
  /** 为什么这个方向是对的 */
  why: string
}

export const DIVERGENCES: Divergence[] = [
  {
    fixture: 'loop-body-failure',
    what: '循环体内下游读到的是哪一轮的数据',
    before: '静默读到上一轮成功那次的输出，渲染出"上一个 vid 的数据贴着本轮的标题"，整条 run 全绿',
    after: '同 loopPath 取不到就是缺失 → 以 MissingValue 失败',
    why:
      '今天体内节点没有任何活性判定（无条件跑），且 ctx.nodes 只在成功时写、按 nodeId 覆盖，' +
      '于是 i=1 失败时 i=0 的输出还留在 ctx 里被下游读到。failCount 记 1 但 results 里没有痕迹。' +
      '这是本轮拆解中发现的既有静默 bug，方向必须翻转 —— 但它是行为变更，所以登记在这里。',
  },
  {
    fixture: 'loop-empty',
    what: 'foreach 展开 0 项时体内节点的记录',
    before: 'run.steps 里完全没有该节点的条目',
    after: "记一条 loopPath=[] 的 skipped，reason='no_iterations'",
    why:
      '"什么都没有"在库里没有痕迹，用户看运行详情时无法区分"体内节点被跳过"和"这个节点不存在"。' +
      '翻译成词汇表里有的取值之后，「为什么没跑」这个问题在每一种情况下都有答案。' +
      '关键是同时保证 each 末端一次都不执行 —— 换成局部规则会变成发一条本不该发的。',
  },
  {
    fixture: 'failfast',
    what: '全局 fail-fast 时被停掉的节点的记录顺序',
    before: '按 topoSort 的次序逐个记 skipped',
    after: 'decide 一次性把所有没有记录的节点记成 skipped，顺序按 nodes 数组',
    why:
      '重算模型没有"遍历到第几个"这个概念。被停掉的集合完全相同，只是写入顺序不同；' +
      'skipped 之间没有先后语义，对比时只比集合不比顺序。',
  },
  {
    fixture: 'loop',
    what: 'flow.foreach 那一行被置为 success 的时刻',
    before: '循环体全部跑完之后才写（runNodeForeach 先记 running，末尾覆盖成 success）',
    after: '展开出 fanout 的那一刻就置 success，体内迭代随后各自成行',
    why:
      'decide 靠 foreach 那一行上的 fanout 决定体内跑几次、跑在哪些 loopPath 上，' +
      '所以它必须先落地。语义上也更对：循环节点的职责是"展开"，展开完它就完成了；' +
      '体内每次迭代的成败是各自那些行的事，不该反过来决定展开这一步是否完成。' +
      '两者产出的内容逐字段相同，差的只是写入顺序。',
  },
]

/** 某份用例是否登记过差异 */
export const divergesOn = (fixture: string): boolean => DIVERGENCES.some((d) => d.fixture === fixture)
