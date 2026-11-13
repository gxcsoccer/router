/**
 * The lab harness: the extracted Engine wired to in-memory ports, plus the small set of moves a main Session and a worker
 * Session would make. It is deliberately synchronous — one `tick()` is one Engine pass — so an experiment is a plain loop
 * over a conversation instead of a timing test.
 */
import {
  Engine, MemoryRepositories, key,
  type Decision, type DomainEvent, type ReceiveResult, type Trigger, type TriggerDisposition, type Ticket, type WorkerReport,
} from '../core/index.ts'
import { candidateCard, QueueAssessor, type CandidateCard } from './assessor.ts'
import { RecordingExecutor } from './executor.ts'
import { MemoryOutbox } from './outbox.ts'
import { createPolicy, type LabPolicyOptions } from './policy.ts'
import { executeRoute, type RouteHost, type RouteResult } from '../routing/route-tool.ts'

export interface LabOptions {
  ownership?: 'thread' | 'routed'
  policy?: LabPolicyOptions
  /** Start time of the lab clock, ISO. */
  start?: string
  /** What the router sees of its tickets: full cards, or a compact task index. */
  cardStyle?: 'full' | 'index'
  /** Personal-agent runs may leave `worktree_name` out of an accept. */
  requireWorktreeName?: boolean
}

export interface TriggerInput {
  text: string
  /** Source-native Thread id the message was written on; the default is a single direct-message thread (`dm`). */
  thread?: string
  actor?: string
  human?: boolean
  addressed?: 'mention' | 'direct' | null
  id?: string
  source?: string
  /** Whether the message has a writable Channel, so an accept can post its acknowledgement. */
  channel?: boolean
}

export interface Delivery {
  assignmentId: string
  inputIds: string[]
  /** Trigger ids carried by those Inputs. */
  triggerIds: string[]
}

export class Lab {
  readonly repo = new MemoryRepositories()
  readonly assessor = new QueueAssessor()
  readonly outbox = new MemoryOutbox()
  readonly executor = new RecordingExecutor()
  readonly events: DomainEvent[] = []
  readonly engine: Engine
  readonly host: RouteHost
  /** Counts `requestPass()` calls, so a test can assert the tool asked for a pass once per call. */
  readonly passes = { requested: 0 }
  private clock: number
  private sequence = 0

  constructor(readonly options: LabOptions = {}) {
    this.clock = Date.parse(options.start ?? '2026-03-01T09:00:00.000Z')
    this.engine = new Engine({
      repo: this.repo,
      now: () => this.now(),
      policy: () => createPolicy(options.policy),
      scope: { scope: () => ({ listened: true, observed: false, row: 'chat' }) },
      assessor: this.assessor,
      executor: this.executor,
      outbox: this.outbox,
      ownership: options.ownership ?? 'thread',
      emit: event => { this.events.push(event) },
    })
    const engine = this.engine
    this.host = {
      decide: (triggerId, outcome) => engine.decide(triggerId, outcome),
      attach: (ticketId, triggerId, note) => engine.attach(ticketId, triggerId, note),
      ticket: id => this.repo.tickets.get(id),
      decisionOf: id => this.repo.triggers.disposition(id)?.decisionId,
      requestPass: () => { this.passes.requested++ },
      quietly: run => run(),
    }
  }

  now(): string { return new Date(this.clock).toISOString() }
  advance(ms: number): void { this.clock += ms }
  /** Source-native id of the lab's default direct-message Thread. */
  get thread(): string { return 'dm' }
  /** Domain key of that Thread, as `threadKey` derives it. */
  get threadKey(): string { return 'chat:dm' }

  /** Receive one message from a source. */
  receive(input: TriggerInput): { result: ReceiveResult; trigger: Trigger } {
    const id = input.id ?? `msg-${++this.sequence}`
    const thread = input.thread ?? this.thread
    const trigger: Trigger = {
      id, source: input.source ?? 'chat',
      threads: [{ source: input.source ?? 'chat', id: thread }],
      actor: { source: input.source ?? 'chat', id: input.actor ?? 'user' },
      human: input.human ?? true,
      ...(input.addressed === null ? {} : { addressed: input.addressed ?? 'direct' }),
      at: this.now(), text: input.text, meta: {},
      ...(input.channel === false ? {} : { channel: { source: input.source ?? 'chat', thread, address: {} } }),
    }
    return { result: this.engine.receive(trigger), trigger }
  }

  /** One Engine pass: expire nothing (the clock is long), start Evals for Threads with queued Triggers. */
  tick(): void { this.engine.evaluateDue() }

  /**
   * The card the main Session would read for this Trigger, if an Eval holds it. Reading it counts as delivery, which starts
   * the Eval's deadline — as `Sessions.prompt` does in the host — so a stuck Eval can actually expire in the lab.
   */
  card(triggerId: string): CandidateCard | undefined {
    const candidate = this.assessor.for(triggerId)
    if (!candidate) return undefined
    this.engine.candidateDelivered(candidate.evalId)
    return candidateCard(candidate, this.options.cardStyle ?? 'full')
  }

  /** Run one `orchestrator_route` call through the extracted tool. */
  route(items: unknown): RouteResult[] | { error: string } {
    const result = executeRoute(this.host, { decisions: items }, { requireWorktreeName: this.options.requireWorktreeName })
    return 'error' in result ? result : result.results
  }

  /** What the extracted tool does for `attach` outside a routing call (the panel's entry point). */
  attach(ticketId: string, triggerId: string, note?: string): Ticket { return this.engine.attach(ticketId, triggerId, note) }

  /** Act as the Executor of one Ticket: start its pending Assignment and hand the waiting Inputs to its worker. */
  deliver(ticketId: string): Delivery | undefined {
    const before = this.repo.tickets.get(ticketId)
    if (!before) return undefined
    const latest = before.assignments.at(-1)
    if (!latest) return undefined
    if (latest.state === 'pending') this.engine.assignmentStarted(ticketId, latest.id)
    const ticket = this.repo.tickets.get(ticketId)!
    const running = ticket.assignments.find(item => item.state === 'running')
    if (!running) return undefined
    const inputIds = [...ticket.undelivered]
    if (inputIds.length) {
      this.engine.inputsDelivered(ticketId, running.id, inputIds)
      this.engine.inputsRead(ticketId, inputIds)
    }
    // The commands the Engine queued for the real Executor are consumed by this method.
    this.executor.take()
    const triggerIds = inputIds.flatMap(id => ticket.inputs.filter(input => input.id === id)
      .map(input => input.kind === 'trigger' ? input.triggerId : undefined))
    return { assignmentId: running.id, inputIds, triggerIds: triggerIds.filter((id): id is string => id !== undefined) }
  }

  /**
   * Answer a message inline, without a ticket: the reply goes to the conversation the person wrote in, and the message is
   * recorded as decided so it does not stay in an Eval. This is the outcome the personal-agent corpus showed is missing.
   */
  answer(triggerId: string, text: string): { id: string; status: string; reused: boolean } {
    const trigger = this.repo.triggers.get(triggerId)
    const id = key('inline-answer', triggerId, text)
    // 核心的 reply 要求"某个 worker 的回答"（Replies.answer 会挑一张票并要求它已答过），内联回答没有票，
    // 宿主只能自己写 Outbox。这正是真实语料暴露的缺口：answer 不是一个一等结果。
    if (trigger?.channel) this.outbox.send({ id, channel: trigger.channel, text, kind: 'reply' })
    this.engine.decide(triggerId, { kind: 'ignore', reason: { code: 'answered' } })
    return { id, status: 'pending', reused: false }
  }

  /** A worker's report on its running Assignment. */
  report(ticketId: string, report: WorkerReport): Ticket { return this.engine.report(ticketId, report) }

  /** A worker handing a message back as beyond its Ticket. */
  handback(ticketId: string, triggerId: string, reason: string): boolean { return this.engine.handback(ticketId, triggerId, reason) }

  decisionOf(triggerId: string): Decision | undefined {
    const id = this.repo.triggers.disposition(triggerId)?.decisionId
    return id ? this.repo.decisions.get(id) : undefined
  }

  disposition(triggerId: string): TriggerDisposition | undefined { return this.repo.triggers.disposition(triggerId) }

  /** Tickets that hold this Trigger as an Input (delivered or waiting). */
  ticketsHolding(triggerId: string): string[] {
    return this.repo.tickets.list().filter(ticket => ticket.inputs.some(input => input.kind === 'trigger' && input.triggerId === triggerId))
      .map(ticket => ticket.id)
  }

  ticket(id: string): Ticket | undefined { return this.repo.tickets.get(id) }
  tickets(): Ticket[] { return this.repo.tickets.list() }
  openTickets(): Ticket[] { return this.repo.tickets.open() }
  /** A stable id for a trigger this lab created, mirroring `key(...)` usage elsewhere. */
  static id(...parts: string[]): string { return key(...parts) }
}
