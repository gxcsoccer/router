/**
 * The personal-agent evaluation. Each scenario is a conversation; each message carries the task it really belongs to and what
 * the router should do. A run drives the extracted Engine exactly as the host does — receive, pass, candidate card, routing
 * tool, worker delivery/handback, completion — and scores where every message ended up.
 *
 * Run: node --experimental-transform-types --no-warnings src/sim/run.ts [--markdown] [--ownership thread|routed] [--router id]
 */
import { SCENARIOS, type Message, type Scenario, type TaskSpec } from './scenarios.ts'
import { ROUTERS, type FollowUpNotice, type RouterChoice, type RouterContext, type RouterPolicy } from './router-policies.ts'
import { Lab } from '../lab/session.ts'
import { llmRouter, type LlmStats } from './llm.ts'
import type { Ticket } from '../core/index.ts'

export type Ownership = 'thread' | 'routed'
export type WorkerStyle = 'diligent' | 'silent'

export interface MessageRow {
  index: number
  text: string
  task: string
  intent: Message['intent']
  /** The ticket this message created, if any. */
  created?: string
  /** Tickets that ended up holding the message. */
  recipients: string[]
  /** Recipients that belong to another task. */
  leakedTo: string[]
  decision?: string
  refused?: string
  /** A worker handed it back and the router then placed it. */
  rescued: boolean
  /** Whether the router ever had a candidate for it. */
  seen: boolean
  unseen: boolean
  correct: boolean
  /** No leak, no loss, no unseen message; a finer task split still counts. */
  safe?: boolean
  /** The routing kind the policy chose for this message (accept / attach / answer / ignore / stop). */
  kind?: string
  problem?: 'leak' | 'fragment' | 'duplicate' | 'lost' | 'unrouted' | 'not-stopped'
}

export interface Metrics {
  messages: number
  correct: number
  /** Messages the router never saw: no candidate reached it. */
  unseen: number
  /** Messages that reached a ticket of another task. */
  leaked: number
  /** A follow-up that started another ticket instead of continuing one. */
  fragmented: number
  /** A new request that was folded into an existing ticket. */
  duplicated: number
  /** Messages that neither leaked into another task nor went unseen nor got lost, whatever the ticket granularity. */
  safe: number
  /** Tickets created beyond the tasks the fixture expects: the router's granularity, not correctness. */
  overSegmentation: number
  /** Messages answered inline instead of becoming a ticket. */
  answered: number
  /** A follow-up that reached no ticket of its task. */
  lost: number
  refused: number
  /** Tickets created against tasks in the fixture. */
  tickets: number
  expectedTasks: number
  resumes: number
  /** Resumes a greeting or a stop caused, not work. */
  spuriousResumes: number
  /** Tickets a person's stop actually ended. */
  stops: number
  maxFanout: number
  meanFanout: number
  /** Triggers swept into a ticket of another task through batching. */
  swept: number
}

export interface RunOptions {
  scenario: Scenario
  ownership: Ownership
  router: RouterPolicy
  worker: WorkerStyle
  /** Simulated gap between two user messages; production gaps run from seconds to hours. Default 30 s. */
  stepMs?: number
  /** Ablation knobs, forwarded to the lab. */
  cardStyle?: 'full' | 'index'
  requireWorktreeName?: boolean
}

export interface RunResult extends RunOptions {
  rows: MessageRow[]
  metrics: Metrics
  tickets: Ticket[]
  log: string[]
}

const task = (scenario: Scenario, id: string): TaskSpec | undefined => scenario.tasks.find(item => item.id === id)

export async function runScenario(options: RunOptions): Promise<RunResult> {
  const { scenario, ownership, router, worker } = options
  const lab = new Lab({ ownership, ...options.cardStyle ? { cardStyle: options.cardStyle } : {},
    ...options.requireWorktreeName !== undefined ? { requireWorktreeName: options.requireWorktreeName } : {} })
  const taskTickets = new Map<string, string[]>()
  const ticketTask = new Map<string, string>()
  const messageTask = new Map<string, string>()
  const messageIntent = new Map<string, Message['intent']>()
  const log: string[] = []
  let worktreeSequence = 0

  const ctx = (message: Message, triggerId: string, peers?: RouterContext['peers']): RouterContext => ({
    text: message.text, task: message.task, intent: message.intent,
    history: received.map(entry => entry.message.text).slice(-8),
    taskTitle: id => task(scenario, id)?.title,
    ticketsFor: id => taskTickets.get(id) ?? [],
    taskOfTicket: id => ticketTask.get(id),
    ...peers ? { peers } : {},
  })
  const item = (choice: RouterChoice, triggerId: string): unknown => {
    switch (choice.kind) {
      case 'accept':
        return { kind: 'accept', trigger_id: triggerId, title: choice.title,
          worktree_name: choice.worktreeName ?? `task-${++worktreeSequence}`,
          acknowledgement: choice.acknowledgement ?? '收到，我看一下' }
      case 'attach':
        return { kind: 'attach', trigger_id: triggerId, ticket_id: choice.ticketId }
      case 'ignore':
        return { kind: 'ignore', trigger_id: triggerId, reason: choice.reason }
      case 'stop':
        return { kind: 'stop', trigger_id: triggerId, ticket_id: choice.ticketId, reason: choice.reason }
      case 'answer':
        throw new Error('answer is handled by the host, not the routing tool')
    }
  }
  /** Route one trigger if it holds a candidate; records the tickets it created and who owns them. */
  const routeOnce = async (message: Message, triggerId: string) => {
    const card = lab.card(triggerId)
    if (!card) return undefined
    // Every other Trigger of the Eval: the card's batch, plus its primary when this Trigger is itself a peer.
    const peers = [card.trigger_id, ...(card.batch ?? []).map(peer => peer.trigger_id)]
      .filter(id => id !== triggerId)
      .map(id => ({ triggerId: id, task: messageTask.get(id) ?? '?', intent: messageIntent.get(id) ?? 'new' as const }))
    const chosen = await router.choose(card, ctx(message, triggerId, peers))
    const choices = Array.isArray(chosen) ? chosen : [chosen]
    const before = new Set(lab.tickets().map(ticket => ticket.id))
    // `answer` is not a routing item: the host replies and then decides the Trigger, as two commands.
    const answered = choices.find(choice => choice.kind === 'answer' && (choice.triggerId ?? triggerId) === triggerId)
    const routed = choices.filter(choice => choice.kind !== 'answer')
    const outcome = routed.length ? lab.route(routed.map(choice => item(choice, choice.triggerId ?? triggerId))) : []
    if (!Array.isArray(outcome)) return { refused: outcome.error, created: [] as string[] }
    if (answered) lab.answer(triggerId, answered.text)
    const results = outcome
    const created = lab.tickets().map(ticket => ticket.id).filter(id => !before.has(id))
    for (const id of created) {
      ticketTask.set(id, message.task)
      taskTickets.set(message.task, [...taskTickets.get(message.task) ?? [], id])
    }
    const own = results.find(result => result.trigger_id === triggerId)
    // A peer's refusal is not this message's; it is logged, but the row's verdict follows its own item.
    const refused = own?.refused
    const peerRefusals = results.filter(result => result.refused && result.trigger_id !== triggerId).length
    log.push(`${message.intent.padEnd(8)} ${triggerId} → ${choices.map(choice => choice.kind).join('+')}`
      + `${created.length ? ` (new ${created[0]!.slice(0, 8)})` : ''}${refused ? ` [refused: ${refused}]` : ''}`)
    const kind = answered ? 'answer'
      : choices.find(choice => (choice.triggerId ?? triggerId) === triggerId)?.kind ?? choices.at(-1)?.kind
    return { decision: own?.decision, refused, created, peerRefusals, kind }
  }
  /** What the host steers into the main Session when a person's message already reached Tickets. */
  const followUp = (entry: { message: Message; triggerId: string }): FollowUpNotice | undefined => {
    const disposition = lab.disposition(entry.triggerId)
    const tickets = (disposition?.fanout ?? []).flatMap(id => {
      const ticket = lab.ticket(id)
      return ticket && !ticket.ended ? [{ ticket_id: id, title: ticket.title, state: 'open' }] : []
    })
    return tickets.length
      ? { kind: 'follow_up', trigger_id: entry.triggerId, text: entry.message.text, delivered_to: tickets }
      : undefined
  }
  /** The router may only stop on such a notice; anything else needs a candidate. */
  const stopFromNotice = async (entry: { message: Message; triggerId: string }) => {
    const notice = followUp(entry)
    if (!notice) return undefined
    const choice = await router.followUp?.(notice, ctx(entry.message, entry.triggerId))
    if (!choice) return undefined
    const results = lab.route([item(choice, entry.triggerId)])
    if ('error' in results) return undefined
    log.push(`${entry.message.intent.padEnd(8)} ${entry.triggerId} → follow_up stop`)
    return results.find(result => result.trigger_id === entry.triggerId && !result.refused)?.decision
  }
  const deliverAll = (message: Message) => {
    const handedBack: string[] = []
    for (const ticket of lab.tickets()) {
      const current = lab.ticket(ticket.id)
      if (!current || current.ended) continue
      const delivery = lab.deliver(ticket.id)
      if (!delivery) continue
      for (const id of delivery.triggerIds) {
        const own = ticketTask.get(ticket.id)
        const messaged = messageTask.get(id)
        if (worker === 'diligent' && own && messaged && own !== messaged) {
          if (lab.handback(ticket.id, id, '这不是本任务的消息')) handedBack.push(id)
        }
      }
    }
    void message
    return handedBack
  }

  const rows: MessageRow[] = []
  let burst = scenario.arrival === 'burst'
  const received: { message: Message; triggerId: string; index: number }[] = []
  const receive = (message: Message, index: number) => {
    const thread = scenario.threadModel === 'per-task' ? `dm:${message.task}` : 'dm'
    const { trigger } = lab.receive({ text: message.text, thread, addressed: message.intent === 'chitchat' ? null : 'direct' })
    messageTask.set(trigger.id, message.task)
    messageIntent.set(trigger.id, message.intent)
    received.push({ message, triggerId: trigger.id, index })
    return trigger.id
  }
  type Outcome = Awaited<ReturnType<typeof routeOnce>>
  const row = (entry: { message: Message; triggerId: string; index: number }, outcome: Outcome, rescued: boolean): MessageRow => {
    const recipients = lab.ticketsHolding(entry.triggerId)
    return { index: entry.index, text: entry.message.text, task: entry.message.task, intent: entry.message.intent,
      ...outcome?.created?.length ? { created: outcome.created[0] } : {}, recipients,
      leakedTo: recipients.filter(id => ticketTask.get(id) !== entry.message.task),
      ...outcome?.decision ? { decision: outcome.decision } : {}, ...outcome?.refused ? { refused: outcome.refused } : {},
      ...outcome?.kind ? { kind: outcome.kind } : {},
      rescued, seen: outcome !== undefined, unseen: outcome === undefined, correct: false }
  }

  if (burst) {
    for (const [index, message] of scenario.messages.entries()) receive(message, index)
    lab.tick()
    let decided = false
    for (const entry of received) {
      if (decided) { rows.push(row(entry, undefined, false)); continue }
      const outcome = await routeOnce(entry.message, entry.triggerId)
      rows.push(row(entry, outcome, false))
      decided = outcome?.decision === 'accept'
    }
  } else {
    for (const [index, message] of scenario.messages.entries()) {
      lab.advance(options.stepMs ?? 30_000)
      const triggerId = receive(message, index)
      lab.tick()
      let routed = await routeOnce(message, triggerId)
      // Only a message intake fanned out gets a follow-up notice; an attach is already a routing call.
      if (!routed) {
        const stopped = await stopFromNotice({ message, triggerId })
        if (stopped) routed = { decision: stopped, created: [] }
      }
      const handedBack = deliverAll(message)
      let rescued = false
      if (handedBack.length) {
        lab.tick()
        for (const id of handedBack) {
          if (id !== triggerId || !lab.card(id)) continue
          const rescue = await routeOnce(message, id)
          if (!rescue) continue
          rescued = true
          routed = { ...rescue, created: [...(routed?.created ?? []), ...rescue.created] }
        }
      }
      const spec = task(scenario, message.task)
      if (spec?.closeAt === index + 1) {
        const ticketId = taskTickets.get(message.task)?.at(-1)
        const ticket = ticketId ? lab.ticket(ticketId) : undefined
        if (ticket && !ticket.ended) lab.report(ticketId!, { state: 'ready', summary: `${spec.title} 完成` })
      }
      rows.push(row({ message, triggerId, index }, routed, rescued))
    }
  }

  // Score.
  for (const row of rows) {
    row.leakedTo = row.recipients.filter(id => ticketTask.get(id) !== row.task)
    const expected = taskTickets.get(row.task)?.[0]
    const endedByPerson = (taskTickets.get(row.task) ?? []).some(id => lab.ticket(id)?.ended?.by === 'human')
    // 安全 = 没有被丢到别的任务、没有被静默丢掉、没有被拒：新建或续接到某张票都算送到了，拆成更细的子任务不算错。
    row.safe = row.leakedTo.length === 0 && !row.unseen && !row.refused
      && (row.intent === 'chitchat' ? true
        : row.intent === 'stop' ? endedByPerson
        : !!row.created || row.recipients.length > 0)
    row.correct = row.intent === 'new' ? !!row.created && row.leakedTo.length === 0
      : row.intent === 'continue' ? !!expected && row.recipients.includes(expected) && !row.created && row.leakedTo.length === 0
      : row.intent === 'stop' ? endedByPerson && row.leakedTo.length === 0
      : row.leakedTo.length === 0
    row.problem = row.correct ? undefined
      : row.leakedTo.length ? 'leak'
      : row.intent === 'continue' && row.created ? 'fragment'
      : row.intent === 'new' && !row.created && row.recipients.length ? 'duplicate'
      : row.intent === 'continue' ? 'lost'
      : row.intent === 'stop' ? 'not-stopped' : 'unrouted'
  }

  const tickets = lab.tickets()
  const resumedEvents = lab.events.filter(event => event.type === 'ticket.resumed')
  const resumes = resumedEvents.length
  const spuriousResumes = resumedEvents.filter(event => ['chitchat', 'stop'].includes(messageIntent.get(event.data.triggerId) ?? '')).length
  const swept = tickets.reduce((count, ticket) => {
    const tasks = new Set(ticket.origin.triggerIds.map(id => messageTask.get(id)).filter(Boolean))
    return count + (tasks.size > 1 ? ticket.origin.triggerIds.length - 1 : 0)
  }, 0)
  const fanout = rows.map(row => row.recipients.length)
  const metrics: Metrics = {
    messages: rows.length,
    correct: rows.filter(row => row.correct).length,
    unseen: rows.filter(row => row.unseen).length,
    leaked: rows.filter(row => row.leakedTo.length).length,
    fragmented: rows.filter(row => row.problem === 'fragment' || row.problem === 'duplicate').length,
    duplicated: rows.filter(row => row.problem === 'duplicate').length,
    safe: rows.filter(row => row.safe).length,
    overSegmentation: tickets.length - scenario.tasks.length,
    answered: rows.filter(row => row.kind === 'answer').length,
    lost: rows.filter(row => row.problem === 'lost').length,
    refused: rows.filter(row => row.refused).length,
    tickets: tickets.length,
    expectedTasks: scenario.tasks.length,
    resumes,
    spuriousResumes,
    stops: tickets.filter(ticket => ticket.ended?.by === 'human').length,
    maxFanout: fanout.length ? Math.max(...fanout) : 0,
    meanFanout: fanout.length ? fanout.reduce((a, b) => a + b, 0) / fanout.length : 0,
    swept,
  }
  return { ...options, rows, metrics, tickets, log }
}

// ── CLI ───────────────────────────────────────────────────────────────────────────────────────────────────────────────

function table(rows: string[][], header: string[]): string {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join(' | ')
  return [line(header), widths.map(width => '-'.repeat(width)).join('-+-'), ...rows.map(line)].join('\n')
}
const pct = (value: number, total: number): string => total ? `${Math.round((value / total) * 100)}%` : '—'

function detail(run: RunResult): string {
  return table(run.rows.map(row => [String(row.index + 1), row.intent, row.text.slice(0, 20),
    row.decision ?? (row.seen ? 'attach' : '（未看到）'), String(row.recipients.length),
    row.leakedTo.length ? '串台' : '—', row.rescued ? '救援' : '—', row.correct ? '✓' : `✗ ${row.problem}`]),
  ['#', '意图', '消息', '决策', '收到票数', '串台', '—', '结果'])
}

async function main(argv: string[]): Promise<void> {
  const markdown = argv.includes('--markdown')
  const ownershipArg = argv.includes('--ownership') ? argv[argv.indexOf('--ownership') + 1] as Ownership : undefined
  const routerArg = argv.includes('--router') ? argv[argv.indexOf('--router') + 1] : undefined
  const modelArg = argv.includes('--model') ? argv[argv.indexOf('--model') + 1] : undefined
  const modes: Ownership[] = ownershipArg ? [ownershipArg] : ['thread', 'routed']
  let stats: LlmStats | undefined
  const routers: readonly RouterPolicy[] = routerArg === 'llm'
    ? [await (async () => { const router = await llmRouter({ model: modelArg, trace: argv.includes('--trace') }); stats = router.stats; return router })()]
    : routerArg ? ROUTERS.filter(router => router.id === routerArg) : ROUTERS
  const lines: string[] = []
  for (const scenario of SCENARIOS) {
    for (const ownership of modes) {
      lines.push(`\n### ${scenario.title} · ownership=${ownership}\n`)
      const body: string[][] = []
      for (const router of routers) {
        const run = await runScenario({ scenario, ownership, router, worker: 'diligent' })
        const m = run.metrics
        body.push([router.label, `${m.correct}/${m.messages} (${pct(m.correct, m.messages)})`, `${m.unseen}`, `${m.leaked}`,
          `${m.fragmented}`, `${m.duplicated}`, `${m.lost}`, `${m.tickets}/${m.expectedTasks}`, `${m.resumes}/${m.spuriousResumes}`,
          `${m.stops}`, `${m.swept}`, m.meanFanout.toFixed(1)])
      }
      lines.push(table(body, ['router', '正确', '未看到', '串台', '碎片', '合并', '丢失', 'tickets/任务', 'resume/空转', '真正停下', 'swept', '平均扇出']))
    }
  }
  const headline = SCENARIOS[0]!
  for (const [ownership, router] of [['thread', ROUTERS[0]!], ['routed', ROUTERS[0]!], ['routed', ROUTERS[1]!]] as const) {
    const run = await runScenario({ scenario: headline, ownership, router, worker: 'diligent' })
    lines.push(`\n### 明细 · ${ownership} · ${router.label}\n`)
    lines.push(detail(run))
  }
  console.log(lines.join('\n'))
  if (stats) console.log(`\nLLM stats: calls=${stats.calls} cached=${stats.cached} repairs=${stats.repairs} invalid=${stats.invalid} failed=${stats.failed}`)
  if (markdown) console.log('\n<!-- 生成自 src/sim/run.ts -->')
}

if (import.meta.url === `file://${process.argv[1]}`) main(process.argv.slice(2))
