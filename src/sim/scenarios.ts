/**
 * Conversation fixtures for the personal-agent evaluation. Every message names the task it really belongs to and what the
 * router should do with it; nothing in the fixture is visible to the router except the text, so a policy that reads only the
 * candidate card is measured against the same ground truth as the oracle.
 */
export type Intent = 'new' | 'continue' | 'stop' | 'chitchat'

export interface Message {
  text: string
  /** Ground-truth task id. */
  task: string
  intent: Intent
}

export interface TaskSpec {
  id: string
  /** Title the router would give the ticket; also what a model reads from a ticket card. */
  title: string
  /** 1-based message ordinal after which the worker reports ready and the ticket ends. Omitted: it stays open. */
  closeAt?: number
}

export interface Scenario {
  id: string
  title: string
  description: string
  /** `single` models one endless chat stream; `per-task` models a client that opens a Thread per task, as GitHub does. */
  threadModel: 'single' | 'per-task'
  /** `spread` delivers one message per pass; `burst` delivers all messages before the first pass. */
  arrival?: 'spread' | 'burst'
  tasks: TaskSpec[]
  messages: Message[]
}

const personalChat: Scenario = {
  id: 'personal-chat',
  title: '单线程个人助理：4 个任务交错出现',
  description: '一个私聊里先后来回 4 个工作项：大阪行程、周报模板、道歉邮件、PR 复核。任务之间会来回切，邮件中途被叫停。',
  threadModel: 'single',
  tasks: [
    { id: 'trip', title: '大阪机票与酒店调研', closeAt: 12 },
    { id: 'report', title: '周报模板调整', closeAt: 14 },
    { id: 'email', title: '客户道歉邮件', closeAt: 9 },
    { id: 'review', title: 'PR 42 diff 复核', closeAt: 15 },
  ],
  messages: [
    { text: '帮我调研一下下周去大阪的机票，周三出发', task: 'trip', intent: 'new' },
    { text: '就这趟大阪，酒店也一起看看，想住难波附近', task: 'trip', intent: 'continue' },
    { text: '对了，上周那个周报模板还在吗', task: 'report', intent: 'new' },
    { text: '把周报模板里的日期改成这一周', task: 'report', intent: 'continue' },
    { text: '再帮我写封给客户的道歉邮件，因为上线延迟', task: 'email', intent: 'new' },
    { text: '邮件语气再软一点，别太正式', task: 'email', intent: 'continue' },
    { text: '大阪那趟还是住难波吧，预算一晚八百', task: 'trip', intent: 'continue' },
    { text: '把刚才那个周报模板导出成 PDF 发我', task: 'report', intent: 'continue' },
    { text: '算了邮件先不写了', task: 'email', intent: 'stop' },
    { text: '帮我看看 PR #42 的 diff 有没有问题', task: 'review', intent: 'new' },
    { text: '那个 diff 里空指针那段怎么改', task: 'review', intent: 'continue' },
    { text: '大阪机票就订周三早上那班', task: 'trip', intent: 'continue' },
    { text: '谢谢', task: 'trip', intent: 'chitchat' },
    { text: '周报里再加一列本周风险', task: 'report', intent: 'continue' },
    { text: 'PR 的测试挂了，帮我看看', task: 'review', intent: 'continue' },
    { text: '大阪酒店预算改成一千', task: 'trip', intent: 'continue' },
  ],
}

const githubLike: Scenario = {
  id: 'thread-per-task',
  title: '每任务一个 Thread（GitHub 式的预期用法）',
  description: '同样的 16 条消息，但客户端为每个任务开了独立 Thread：Thread 即任务，订阅即归属。',
  threadModel: 'per-task',
  tasks: personalChat.tasks,
  messages: personalChat.messages,
}

const burst: Scenario = {
  id: 'burst',
  title: '一个批次里的三条无关请求',
  description: '三条互不相关的请求在同一个 pass 窗口内到达同一个 Thread：它们会被合成一个 Eval，一条 accept 决定整个批次。',
  threadModel: 'single',
  arrival: 'burst',
  tasks: [
    { id: 'a', title: '大阪机票', closeAt: 99 },
    { id: 'b', title: '周报模板', closeAt: 99 },
    { id: 'c', title: '客户道歉邮件', closeAt: 99 },
  ],
  messages: [
    { text: '帮我查一下下周去大阪的机票', task: 'a', intent: 'new' },
    { text: '帮我改一下周报模板里的日期', task: 'b', intent: 'new' },
    { text: '帮我写封给客户的道歉邮件', task: 'c', intent: 'new' },
  ],
}

/** The same three requests, one pass apart: no batch, so no sweep. */
const burstSplit: Scenario = { ...burst, id: 'burst-split', title: '三条无关请求，分三个 pass 到达（对照）', arrival: 'spread' }


/**
 * Ten tasks, then returns to the oldest one. `related_tickets` shows at most eight, newest first among open ones, so the
 * first two tasks are not on the card when the user returns to them. Isolates the card's recall ceiling.
 */
const manyTasks: Scenario = {
  id: 'many-tasks',
  title: '十个任务后回头找最早的那个',
  description: '连续开十个任务，再续接第 1 个（不在卡片可见的 8 张里）和第 10 个（可见）。',
  threadModel: 'single',
  tasks: [
    { id: 't1', title: '发票报销流程说明' },
    { id: 't2', title: '新员工入职第一周清单' },
    { id: 't3', title: '上周销售数据图表' },
    { id: 't4', title: '杭州下周天气' },
    { id: 't5', title: 'v2.3 发版说明' },
    { id: 't6', title: '会议录音要点摘要' },
    { id: 't7', title: '团队团建餐厅' },
    { id: 't8', title: '本季度差旅预算' },
    { id: 't9', title: '给供应商的催货邮件' },
    { id: 't10', title: '客户反馈高频问题' },
  ],
  messages: [
    { text: '帮我整理一下发票报销流程的说明', task: 't1', intent: 'new' },
    { text: '给新员工写一段入职第一周的清单', task: 't2', intent: 'new' },
    { text: '把上周的销售数据做成一个简单的图表', task: 't3', intent: 'new' },
    { text: '查一下杭州下周的天气', task: 't4', intent: 'new' },
    { text: '给产品写一份 v2.3 的发版说明', task: 't5', intent: 'new' },
    { text: '帮我把会议录音的要点整理成摘要', task: 't6', intent: 'new' },
    { text: '找一个适合团队团建的餐厅', task: 't7', intent: 'new' },
    { text: '把这季度的差旅预算算一下', task: 't8', intent: 'new' },
    { text: '写一封给供应商的催货邮件', task: 't9', intent: 'new' },
    { text: '整理一下客户反馈里的高频问题', task: 't10', intent: 'new' },
    { text: '之前那个发票报销流程的说明，把第二步改清楚一点', task: 't1', intent: 'continue' },
    { text: '客户反馈那份，再加一列出现次数', task: 't10', intent: 'continue' },
  ],
}

/** Two tasks that share every keyword. The only difference is which team the document is for. */
const twinSubjects: Scenario = {
  id: 'twin-subjects',
  title: '同主题不同对象：A/B/C 三个团队的周报模板',
  description: '三份几乎同名的文档，续接时必须按团队区分；相似主题不能当成同一张票。',
  threadModel: 'single',
  tasks: [
    { id: 'a', title: 'A 团队周报模板使用说明' },
    { id: 'b', title: 'B 团队周报模板使用说明' },
    { id: 'c', title: 'C 团队周报模板使用说明' },
  ],
  messages: [
    { text: '给 A 团队写一份周报模板的使用说明', task: 'a', intent: 'new' },
    { text: '给 B 团队也写一份周报模板的使用说明', task: 'b', intent: 'new' },
    { text: 'A 团队那份，把标题改成英文', task: 'a', intent: 'continue' },
    { text: 'B 团队那份，加一节风险提示', task: 'b', intent: 'continue' },
    { text: '再给 C 团队写一份周报模板的使用说明', task: 'c', intent: 'new' },
    { text: 'C 团队那份的日期格式改成 YYYY-MM-DD', task: 'c', intent: 'continue' },
    { text: '算了 B 团队那份先不写了', task: 'b', intent: 'stop' },
  ],
}

/**
 * Twenty messages, six tasks, two completions: two returns land on ended tickets, which the card sorts after the open ones.
 * Tests long-range resume, interleaving and the "谢谢" tail.
 */
const longStream: Scenario = {
  id: 'long-stream',
  title: '二十条消息、六个任务、两次回到已完成的任务',
  description: '中途完成两个任务，之后又回来续接；卡片上同时有 4 张进行中和 2 张已结束的票。',
  threadModel: 'single',
  tasks: [
    { id: 'trip', title: '京都四天行程', closeAt: 14 },
    { id: 'okr', title: '团队 OKR 初稿', closeAt: 6 },
    { id: 'mail', title: '预算申请邮件' },
    { id: 'contract', title: '合同风险条款复核' },
    { id: 'shift', title: '下周团队排班表' },
    { id: 'speech', title: '产品发布会开场白' },
  ],
  messages: [
    { text: '帮我规划下个月去京都的四天行程', task: 'trip', intent: 'new' },
    { text: '也看看京都的民宿，预算一晚六百', task: 'trip', intent: 'continue' },
    { text: '顺便查一下京都十一月的天气', task: 'trip', intent: 'continue' },
    { text: '帮我写一份团队 OKR 的初稿', task: 'okr', intent: 'new' },
    { text: 'OKR 里第二条改成可量化的', task: 'okr', intent: 'continue' },
    { text: '再把 OKR 整理成一页纸', task: 'okr', intent: 'continue' },
    { text: '给老板写一封申请预算的邮件', task: 'mail', intent: 'new' },
    { text: '邮件里加上项目延期的说明', task: 'mail', intent: 'continue' },
    { text: '京都行程的第三天安排得松一点', task: 'trip', intent: 'continue' },
    { text: '帮我看看这份合同有没有风险条款', task: 'contract', intent: 'new' },
    { text: '合同里违约金那条再解释一下', task: 'contract', intent: 'continue' },
    { text: '做一个下周的团队排班表', task: 'shift', intent: 'new' },
    { text: '排班表里小王那天换成休息', task: 'shift', intent: 'continue' },
    { text: '京都的民宿订了吗，帮我确认一下', task: 'trip', intent: 'continue' },
    { text: '写一段产品发布会的开场白', task: 'speech', intent: 'new' },
    { text: '开场白再短一点，两分钟以内', task: 'speech', intent: 'continue' },
    { text: 'OKR 那页纸再加一个负责人', task: 'okr', intent: 'continue' },
    { text: '合同违约金那条帮我标红', task: 'contract', intent: 'continue' },
    { text: '京都行程能不能加一天', task: 'trip', intent: 'continue' },
    { text: '谢谢', task: 'trip', intent: 'chitchat' },
  ],
}

export const SCENARIOS: readonly Scenario[] = [personalChat, githubLike, burst, burstSplit, manyTasks, twinSubjects, longStream]
export const BY_ID: Record<string, Scenario> = Object.fromEntries(SCENARIOS.map(scenario => [scenario.id, scenario]))
export { personalChat, githubLike, burst, burstSplit, manyTasks, twinSubjects, longStream }
