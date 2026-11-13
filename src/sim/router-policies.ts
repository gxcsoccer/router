/**
 * Router policies. Only `oracle` sees ground truth; the others read exactly what the main Session reads — the candidate card
 * and the ticket cards in it. `keyword` is a deterministic word-matching stand-in for a model that matches words but not
 * paraphrase: a lower bound on what a real model can do, not a claim about one.
 */
import type { CandidateCard } from '../lab/assessor.ts'

export type RouterChoice =
  | { kind: 'accept'; title: string; triggerId?: string; worktreeName?: string; acknowledgement?: string }
  /** Answer inline, without a ticket: the host replies to the source message and the Trigger is decided. */
  | { kind: 'answer'; text: string; triggerId?: string }
  | { kind: 'attach'; ticketId: string; triggerId?: string }
  | { kind: 'ignore'; reason: string; triggerId?: string }
  | { kind: 'stop'; ticketId: string; reason: string; triggerId?: string }

export interface RouterContext {
  /** The Trigger under decision (may be a batch peer rather than the card's primary). */
  text: string
  /** Ground truth, used by `oracle` only. */
  task: string
  intent: 'new' | 'continue' | 'stop' | 'chitchat'
  taskTitle(task: string): string | undefined
  /** Tickets created for a task, oldest first. */
  ticketsFor(task: string): readonly string[]
  taskOfTicket(ticketId: string): string | undefined
  /** Batch peers of the current Trigger, with the task and intent each really belongs to. */
  peers?: readonly { triggerId: string; task: string; intent: 'new' | 'continue' | 'stop' | 'chitchat' }[]
  /** The conversation the main Session has seen, oldest first: the texts of the messages before this one. */
  history?: readonly string[]
}

/** The `follow_up` steering relay a hosted router receives for a person's message a Ticket's worker already owns. */
export interface FollowUpNotice {
  kind: 'follow_up'
  trigger_id: string
  text: string
  delivered_to: { ticket_id: string; title: string; state: string }[]
}
export interface RouterPolicy {
  id: string
  label: string
  /** One decision, or several items for one call (batch hygiene decides the peers first). */
  choose(card: CandidateCard, ctx: RouterContext): RouterChoice | RouterChoice[] | Promise<RouterChoice | RouterChoice[]>
  /** What it does with a follow-up it may only stop; most routers do nothing. */
  followUp?(notice: FollowUpNotice, ctx: RouterContext): RouterChoice | undefined | Promise<RouterChoice | undefined>
}

/** Perfect semantic routing: what the router would decide if it understood the conversation. */
export const oracle: RouterPolicy = {
  id: 'oracle', label: 'oracle（机制上界）',
  choose(_card, ctx) {
    const ticketId = ctx.ticketsFor(ctx.task).at(-1)
    if (ctx.intent === 'new' || (ctx.intent === 'continue' && !ticketId)) return { kind: 'accept', title: ctx.taskTitle(ctx.task) ?? ctx.text.slice(0, 16) }
    if (ctx.intent === 'continue' && ticketId) return { kind: 'attach', ticketId }
    if (ctx.intent === 'stop' && ticketId) return { kind: 'stop', ticketId, reason: '明确叫停' }
    return { kind: 'ignore', reason: '不需要任务' }
  },
  followUp(notice, ctx) {
    if (ctx.intent !== 'stop') return undefined
    const target = notice.delivered_to.find(ticket => ctx.taskOfTicket(ticket.ticket_id) === ctx.task)
    return target ? { kind: 'stop', ticketId: target.ticket_id, reason: '明确叫停' } : undefined
  },
}

/**
 * `oracle` plus batch hygiene: peer Triggers of the same Eval that belong to another task are ignored in the same call
 * before the current one is decided, so an unrelated message is never swept into the new ticket's origin.
 */
export const oracleHygienic: RouterPolicy = {
  id: 'oracle-hygienic', label: 'oracle + 批次清理',
  followUp: oracle.followUp,
  choose(card, ctx) {
    const primary = oracle.choose(card, ctx) as RouterChoice
    const strays = (ctx.peers ?? []).filter(peer => peer.task !== ctx.task && peer.triggerId !== card.trigger_id)
    return [...strays.map(peer => ({ kind: 'ignore' as const, triggerId: peer.triggerId, reason: `与本任务无关的批次消息 ${peer.task}` })), primary]
  },
}

/** Naive baselines, to show what the numbers look like without any grouping at all. */
export const alwaysNew: RouterPolicy = {
  id: 'always-new', label: 'always-new（每条都开新任务）',
  choose(card, ctx) { return { kind: 'accept', title: ctx.text.replace(/\s+/g, ' ').slice(0, 16) || card.trigger_id } },
}

export const attachNewest: RouterPolicy = {
  id: 'attach-newest', label: 'attach-newest（都塞进最新任务）',
  choose(card, ctx) {
    const open = card.related_tickets.filter(ticket => !['completed', 'merged', 'closed', 'dropped', 'stopped'].includes(ticket.state))
    return open[0] ? { kind: 'attach', ticketId: open[0].ticket_id } : { kind: 'accept', title: ctx.text.replace(/\s+/g, ' ').slice(0, 16) || card.trigger_id }
  },
}

const STOP = /算了|先不|不写了|取消|停一下|不用了/
const CHITCHAT = /^(谢谢|谢了|好的|好|嗯+|ok|thanks|thank you)[!！。.\s]*$/i
/** Bigrams that carry no task identity in this corpus. */
const NOISE = new Set(['帮我', '我一', '一下', '看看', '这个', '那个', '一个', '还是', '就是', '可以', '我们', '你们', '什么', '怎么',
  '先不', '也一', '再帮', '有点', '以及', '然后', '现在', '这周', '本周', '改成', '导出', '有没有', '问题'])

/** Meaningful word units: Latin words and CJK bigrams, without punctuation or noise bigrams. */
function units(text: string): Set<string> {
  const clean = text.toLowerCase().replace(/[，。！？、：；"'“”‘’（）()\[\]{}<>《》!?.,:;\s]+/g, ' ').trim()
  const out = new Set<string>()
  for (const word of clean.split(' ')) if (/[a-z0-9]/.test(word)) out.add(word)
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.add(run)
    for (let index = 0; index + 1 < run.length; index++) {
      const gram = run.slice(index, index + 2)
      if (!NOISE.has(gram)) out.add(gram)
    }
  }
  return out
}
export interface Scored { ticketId: string; title: string; hits: string[] }
/** Which of the message's word units appear in a ticket card; the router's only evidence about a ticket. */
export function score(text: string, ticket: CandidateCard['related_tickets'][number]): Scored {
  const haystack = units(`${ticket.title} ${ticket.preview}`)
  const hits = [...units(text)].filter(unit => haystack.has(unit))
  return { ticketId: ticket.ticket_id, title: ticket.title, hits }
}
export function rank(text: string, card: CandidateCard): Scored[] {
  return card.related_tickets.map(ticket => score(text, ticket)).sort((a, b) => b.hits.length - a.hits.length)
}

/**
 * A word-matching router: a stop or a greeting by phrase, otherwise attach to the ticket whose card shares the most
 * meaningful words with the message — provided it shares at least two, and strictly more than the runner-up. Otherwise a
 * new task. Two rather than one keeps a single shared word ("邮件", "PR") from pulling an unrelated message into a ticket.
 */
export function keyword(minHits = 2): RouterPolicy {
  return {
    id: `keyword-${minHits}`, label: `keyword（词面命中 ≥ ${minHits}）`,
    choose(card, ctx) {
      const ranked = rank(ctx.text, card)
      const best = ranked[0]
      const second = ranked[1]
      if (STOP.test(ctx.text) && best && best.hits.length) return { kind: 'stop', ticketId: best.ticketId, reason: '用户叫停' }
      if (best && best.hits.length >= minHits && (!second || best.hits.length > second.hits.length)) {
        return { kind: 'attach', ticketId: best.ticketId }
      }
      if (CHITCHAT.test(ctx.text) || ctx.text.trim().length <= 3) return { kind: 'ignore', reason: '闲聊' }
      return { kind: 'accept', title: ctx.text.replace(/\s+/g, ' ').slice(0, 18) }
    },
    followUp(notice, ctx) {
      if (!STOP.test(ctx.text)) return undefined
      const words = units(ctx.text)
      const target = notice.delivered_to.find(ticket => units(ticket.title).size
        && [...units(ticket.title)].some(unit => words.has(unit)))
      return target ? { kind: 'stop', ticketId: target.ticket_id, reason: '用户叫停' } : undefined
    },
  }
}

/**
 * The compliant router: one item for every Trigger of the batch, so no unrelated message is swept into a ticket and none is
 * dropped. A peer that starts a task of its own is accepted; one whose task already has a live ticket is attached; anything
 * else (a dead task, a greeting) is ignored.
 */
export const oraclePerTrigger: RouterPolicy = {
  id: 'oracle-per-trigger', label: 'oracle（逐条决定整个批次）',
  followUp: oracle.followUp,
  choose(card, ctx) {
    const own = oracle.choose(card, ctx) as RouterChoice
    const peers = (ctx.peers ?? []).filter(peer => peer.triggerId !== card.trigger_id)
    const items: RouterChoice[] = []
    for (const peer of peers) {
      if (peer.task === ctx.task) continue
      const covered = ctx.ticketsFor(peer.task).length > 0
      // A peer that starts a task of its own gets its own ticket; one already covered by a ticket is a duplicate or an orphan
      // left by a stop, so it is ignored rather than swept or dropped silently.
      if (!covered && peer.intent !== 'chitchat') {
        items.push({ kind: 'accept', triggerId: peer.triggerId, title: ctx.taskTitle(peer.task) ?? peer.task })
        continue
      }
      items.push({ kind: 'ignore', triggerId: peer.triggerId, reason: `${peer.task} 已有任务或无需任务` })
    }
    return [...items, own]
  },
}

export const ROUTERS: readonly RouterPolicy[] = [oracle, oraclePerTrigger, oracleHygienic, keyword(2), attachNewest, alwaysNew]
