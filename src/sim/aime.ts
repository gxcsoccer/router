/**
 * Aime 对话导出 → 评测语料。
 *
 * 导出的是一段**连续**的对话（2026-09-30 至 2026-11-14，321 条用户消息），正是 personal agent 里最难的那种输入：
 * 没有会话边界、任务来回切、中间夹着提醒与交付。这里只做三件事：把纯文本解析成消息、按用户轮次切窗口、把人工标注
 * 套成 `Scenario`。原始文本不进入仓库：标注只存轮次、意图与任务，正文在运行时从句料读取。
 */
import { readFileSync } from 'node:fs'
import type { Intent, Message, Scenario, TaskSpec } from './scenarios.ts'

export interface AimeMessage {
  /** 在整段流里的序号，从 0 开始，只数正文（不含待核对附录）。 */
  index: number
  date: string
  at: string
  role: 'user' | 'assistant'
  text: string
  appendix: boolean
}

const DATE = /^\d{4}-\d{2}-\d{2}$/
const ROLE = /^\[(\d{2}:\d{2}:\d{2})\] (你|Aime)\s*$/
const RULE = /^={10,}$/

/** Parse the export: date sections, `[HH:MM:SS] 你|Aime` blocks, and the appendix after its heading. */
export function parseAime(source: string): AimeMessage[] {
  const lines = source.split(/\r?\n/)
  const messages: AimeMessage[] = []
  let date = ''
  let appendix = false
  let current: { at: string; role: 'user' | 'assistant'; body: string[] } | undefined
  const flush = () => {
    if (!current) return
    const text = current.body.join('\n').trim()
    if (text) messages.push({ index: messages.length, date, at: current.at, role: current.role, text, appendix })
    current = undefined
  }
  for (const line of lines) {
    if (line.startsWith('待核对附录')) { flush(); appendix = true; continue }
    if (RULE.test(line)) { flush(); continue }
    if (DATE.test(line.trim())) { flush(); date = line.trim(); continue }
    const role = ROLE.exec(line)
    if (role) {
      flush()
      current = { at: role[1]!, role: role[2] === '你' ? 'user' : 'assistant', body: [] }
      continue
    }
    if (current) current.body.push(line)
  }
  flush()
  return messages
}

export function loadAime(path: string): AimeMessage[] {
  return parseAime(readFileSync(path, 'utf8'))
}

export const userMessages = (messages: AimeMessage[]): AimeMessage[] =>
  messages.filter(message => !message.appendix && message.role === 'user')

/** 一条用户消息与它之后的助手回复。 */
export interface Turn { user: AimeMessage; replies: AimeMessage[] }

/** 第 `fromTurn` 到 `toTurn`（含，1 起）用户轮次，连同回复。 */
export function turns(messages: AimeMessage[], fromTurn: number, toTurn: number): Turn[] {
  const users = userMessages(messages)
  const from = users[fromTurn - 1]!.index
  const to = users[toTurn - 1]!.index + 1
  const out: Turn[] = []
  let pending: Turn | undefined
  for (const message of messages) {
    if (message.appendix || message.index < from || message.index >= to) continue
    if (message.role === 'user') {
      if (pending) out.push(pending)
      pending = { user: message, replies: [] }
    } else if (pending) pending.replies.push(message)
  }
  if (pending) out.push(pending)
  return out
}

/**
 * 人工标注。`turn` 是窗口内第几条用户消息（1 起）。
 * - `new`：开一个新任务，必须给 `task`
 * - `continue` / `stop`：续接（或叫停）窗口里已有的任务，必须给 `of`
 * - `chitchat`：不需要任务，直接答或忽略
 */
export interface Label { turn: number; intent: Intent; task?: string; of?: string; why?: string }
export interface LabelSet {
  id: string
  title: string
  fromTurn: number
  toTurn: number
  tasks: { id: string; title: string }[]
  /** 任务在该轮之后完成（worker 报告 ready），用于制造"之后回来要 resume"的场景。键是任务 id，值是轮次。 */
  closeOn?: Record<string, number>
  labels: Label[]
}

/** 把标注套成 `Scenario`：整段流是一个 Thread（这正是语料的难点）。 */
export function aimeScenario(source: AimeMessage[], set: LabelSet): Scenario {
  const window = turns(source, set.fromTurn, set.toTurn)
  if (window.length !== set.labels.length) {
    throw new Error(`${set.id}: window has ${window.length} user turns but ${set.labels.length} labels`)
  }
  const messages: Message[] = set.labels.map((label, index) => {
    // chitchat 没有任务：给一个不会开出票的伪任务名，只用于记录归属。
    const task = label.task ?? label.of ?? (label.intent === 'chitchat' ? 'chitchat' : undefined)
    if (!task) throw new Error(`${set.id} turn ${label.turn}: neither task nor of`)
    if (label.intent === 'new' && !label.task) throw new Error(`${set.id} turn ${label.turn}: new without task`)
    if ((label.intent === 'continue' || label.intent === 'stop') && !label.of) throw new Error(`${set.id} turn ${label.turn}: ${label.intent} without of`)
    return { text: window[index]!.user.text.replace(/\s+/g, ' ').trim(), task, intent: label.intent }
  })
  const tasks: TaskSpec[] = set.tasks.map(task => ({ id: task.id, title: task.title,
    ...set.closeOn?.[task.id] !== undefined ? { closeAt: set.closeOn[task.id]! } : {} }))
  return { id: `aime-${set.id}`, title: set.title,
    description: `Aime 导出，轮次 ${set.fromTurn}–${set.toTurn}（${window[0]!.user.date} → ${window.at(-1)!.user.date}）`,
    threadModel: 'single', tasks, messages }
}

/** 没有标注时，把每条用户消息当成独立"轮次"，只用于统计结构（建票数、扇出、未看到），不用于判分。 */
export function streamScenario(source: AimeMessage[], fromTurn: number, toTurn: number): Scenario {
  const window = turns(source, fromTurn, toTurn)
  return { id: `aime-stream-${fromTurn}-${toTurn}`, title: `Aime 真实流量 ${fromTurn}–${toTurn}`,
    description: '未标注：只看结构指标', threadModel: 'single',
    tasks: window.map((_, index) => ({ id: `m${index + 1}`, title: '' })),
    messages: window.map((turn, index) => ({ text: turn.user.text.replace(/\s+/g, ' ').trim(), task: `m${index + 1}`, intent: 'new' as const })) }
}
