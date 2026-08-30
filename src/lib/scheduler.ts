/**
 * 调度器接没接上。
 *
 * `trigger.schedule` 现在**只有 UI**：节点配得好好的，describeSchedule 把它
 * 翻译成「每天 09:00」显示给用户，但没有任何进程会在 09:00 跑它。
 *
 * 这不是"功能还没做"，是**界面在撒谎** —— 用户配了定时，合理地相信它会跑，
 * 然后某天发现日报一次都没发过。整个项目里最严重的失败模式就是这一类：
 * 静默地不干活，而且看起来一切正常。
 *
 * 在调度器落地之前，这件事必须在每一个用户会形成"它会自动跑"这个信念的地方
 * 说出来：配置节点时、看流程列表时。
 *
 * M2 之后它不再是常量，而是**读后端上报的调度器心跳** —— 因为调度器
 * 静默死掉和从来没接入是同一种后果，而且更隐蔽：那时用户有理由相信它在跑。
 * worker 每轮 tick 写一次心跳，超过 120 秒没动静就算死了。
 */
let schedulerAlive = false

/** 调度器活着没。由 /health 探测结果更新，**不是硬编码** */
export const isSchedulerAlive = (): boolean => schedulerAlive

export function setSchedulerAlive(alive: boolean): void {
  schedulerAlive = alive
}

/** 节点上那一行短提示 */
export const SCHEDULER_OFF_SHORT = '不会自动运行 —— worker 没在跑'

/**
 * 悬停/详情里的完整说法。
 *
 * 以前这里写的是「这条流程只能手动点运行」—— **这句是错的，而且错得很贵**：
 * 接了流程存储之后，手动运行走的也是 worker（createRun 插一行 queued，
 * 捡起来执行的是 worker；心跳和 claimRun 在同一轮 tick 里）。worker 不在时
 * 手动点运行同样跑不起来，只会得到一条永远排队的记录和一个永远转圈的界面。
 * 照着这句话去点运行的人，只会更确信"是这个按钮坏了"。
 */
export const SCHEDULER_OFF_DETAIL =
  'worker 没在跑，定时配置不会被执行。\n' +
  '手动点「运行」同样跑不起来 —— 服务端运行也要 worker 捡起来执行，\n' +
  '不起 worker 只会得到一条一直排队的记录。\n' +
  '起一个：npm run worker'
