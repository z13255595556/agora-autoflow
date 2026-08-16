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
export const SCHEDULER_OFF_SHORT = '不会自动运行 —— 调度器没在跑'

/** 悬停/详情里的完整说法 */
export const SCHEDULER_OFF_DETAIL =
  '调度器没在跑，定时配置不会被执行。\n' +
  '这条流程只能手动点「运行」。起一个 worker（npm run worker）后此提示会消失。'
