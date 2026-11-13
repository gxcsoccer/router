/**
 * `orchestrator_route`, ported without zod from dsh-superagent's `src/app/tools/main.ts`.
 *
 * The shape is unchanged: one call carries up to 20 decisions, each names a `trigger_id` whose whole batch it decides, and
 * each item runs as its own Engine command so a refused item leaves the others alone. What changed: the schema is checked by
 * the hand-written `parseCall`/`invalid` pair instead of zod, and the ticket projection is trimmed to the fields the routing
 * result uses. Field-level rules (which kind reads and needs which field) are identical to the original `FIELDS` table.
 */
import { UserError, reasonText, ticketStage, type Decision, type DecisionKind, type Outcome, type Ticket } from '../core/index.ts'
import { IM_WORDS, NOTE_WORDS, wordCount } from './limits.ts'

export type RouteKind = 'accept' | 'attach' | 'ignore' | 'stop'
/** One routing decision; every field but `kind` and `trigger_id` belongs to some kinds only (see `FIELDS`). */
export interface RouteItem {
  kind: RouteKind
  trigger_id: string
  ticket_id?: string | null
  title?: string | null
  worktree_name?: string | null
  acknowledgement?: string | null
  note?: string | null
  reason?: string | null
}
export const ROUTE_ITEMS_MAX = 20
const KEYS = ['kind', 'trigger_id', 'ticket_id', 'title', 'worktree_name', 'acknowledgement', 'note', 'reason'] as const
const KINDS: readonly RouteKind[] = ['accept', 'attach', 'ignore', 'stop']

type Field = Exclude<keyof RouteItem, 'kind' | 'trigger_id'>
/** Each field's check, the kinds whose items read it and those that need it; an item of another kind leaves it unread. */
const FIELDS: Record<Field, { check: (value: string) => string | undefined; reads: readonly RouteKind[]; needs: readonly RouteKind[] }> = {
  ticket_id: { check: nonEmpty, reads: ['attach', 'stop'], needs: ['attach', 'stop'] },
  title: { check: value => value.length > 200 ? 'title: at most 200 characters' : undefined, reads: ['accept'], needs: ['accept'] },
  worktree_name: { check: worktreeName, reads: ['accept'], needs: ['accept'] },
  acknowledgement: { check: acknowledgement, reads: ['accept'], needs: ['accept'] },
  note: { check: note, reads: ['accept', 'attach'], needs: [] },
  reason: { check: value => value.length > 500 ? 'reason: at most 500 characters' : undefined, reads: ['ignore', 'stop'], needs: ['ignore'] },
}
function nonEmpty(value: string): string | undefined { return value.trim() ? undefined : 'must not be empty' }
function worktreeName(value: string): string | undefined {
  if (value.length > 32) return 'worktree_name: at most 32 characters'
  return /^[a-z]+(?:-[a-z0-9]+){0,3}$/.test(value)
    ? undefined : 'worktree_name: 1–4 short English words in lowercase kebab-case, at most 32 characters'
}
function acknowledgement(value: string): string | undefined {
  if (!value.trim()) return 'acknowledgement: must not be empty'
  const count = wordCount(value)
  return count > IM_WORDS ? `acknowledgement: ${count} words; at most ${IM_WORDS}` : undefined
}
function note(value: string): string | undefined {
  const count = wordCount(value)
  return count > NOTE_WORDS ? `note: ${count} words; at most ${NOTE_WORDS} (routing background or a human constraint, never instructions)` : undefined
}

/** Lab knob for the ablation: a personal-agent deployment may not name a git worktree at all. */
export interface RouteToolOptions { requireWorktreeName?: boolean }
/** Why an item cannot run: a field its kind needs is missing, or one it reads breaks its limit. */
export function invalid(item: RouteItem, options: RouteToolOptions = {}): string | undefined {
  for (const [field, { check, reads, needs: declared }] of Object.entries(FIELDS) as [Field, typeof FIELDS[Field]][]) {
    const needs = field === 'worktree_name' && options.requireWorktreeName === false ? [] : declared
    const value = item[field]
    if (!reads.includes(item.kind)) continue
    if (value === undefined || value === null || value.trim() === '') {
      if (needs.includes(item.kind)) return `${item.kind} needs ${field}`
      continue
    }
    const checked = check(value)
    if (checked) return checked
  }
  return undefined
}

export type ParsedCall = { ok: true; items: RouteItem[] } | { ok: false; error: string }
/**
 * Parse a whole call: an object with a `decisions` array of 1–20 items, each an object with only the known keys. This is
 * where the original's `.strict()` and `.min(1).max(20)` live; field content is left to `invalid` so one bad item cannot
 * fail the whole call.
 */
export function parseCall(input: unknown): ParsedCall {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { ok: false, error: 'Expected an object with decisions' }
  const keys = Object.keys(input)
  const unknownCall = keys.filter(key => key !== 'decisions')
  if (unknownCall.length) return { ok: false, error: `Unknown argument(s): ${unknownCall.join(', ')}` }
  const decisions = (input as { decisions?: unknown }).decisions
  if (!Array.isArray(decisions)) return { ok: false, error: 'decisions must be an array' }
  if (decisions.length < 1) return { ok: false, error: 'At least one decision is required' }
  if (decisions.length > ROUTE_ITEMS_MAX) return { ok: false, error: `At most ${ROUTE_ITEMS_MAX} decisions per call` }
  const items: RouteItem[] = []
  for (const [index, raw] of decisions.entries()) {
    const parsed = parseItem(raw)
    if (!parsed.ok) return { ok: false, error: `decisions[${index}]: ${parsed.error}` }
    items.push(parsed.item)
  }
  return { ok: true, items }
}
function parseItem(raw: unknown): { ok: true; item: RouteItem } | { ok: false; error: string } {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, error: 'Expected an object' }
  const record = raw as Record<string, unknown>
  const unknown = Object.keys(record).filter(key => !KEYS.includes(key as typeof KEYS[number]))
  if (unknown.length) return { ok: false, error: `unknown field(s): ${unknown.join(', ')}` }
  if (!KINDS.includes(record.kind as RouteKind)) return { ok: false, error: `kind must be one of ${KINDS.join(', ')}` }
  if (typeof record.trigger_id !== 'string' || !record.trigger_id) return { ok: false, error: 'trigger_id must be a non-empty string' }
  const item: RouteItem = { kind: record.kind as RouteKind, trigger_id: record.trigger_id }
  for (const key of KEYS) {
    if (key === 'kind' || key === 'trigger_id') continue
    const value = record[key]
    if (value === undefined || value === null) continue
    if (typeof value !== 'string') return { ok: false, error: `${key} must be a string` }
    item[key] = value
  }
  return { ok: true, item }
}

/** What the tool needs of the Engine, its store and the pass scheduler. */
export interface RouteHost {
  decide(triggerId: string, outcome: Outcome): Decision
  attach(ticketId: string, triggerId: string, note?: string): Ticket
  ticket(id: string): Ticket | undefined
  /** The Decision id the Trigger already has, if any; an accept that returns it is idempotent. */
  decisionOf(triggerId: string): string | undefined
  /** Schedule an Engine pass to carry out what the decision queued. */
  requestPass(): void
  /** Run an Engine command initiated by the main Session without emitting self-notifications. */
  quietly<T>(run: () => T): T
}

/** The ticket projection a routing result carries (`ticketCard` in dsh-superagent, trimmed to the routing fields). */
export function ticketCard(ticket: Ticket) {
  const state = ticket.ended ? ticket.ended.outcome : (() => {
    const stage = ticketStage(ticket)
    if (stage.stage === 'person') return `person/${stage.action}`
    return stage.stage === 'idle' ? 'idle' : stage.stage === 'working' && stage.action ? 'working/queued' : 'working'
  })()
  return { ticket_id: ticket.id, title: ticket.title, state, strength: ticket.mandate.strength,
    preview: (ticket.assignments.findLast(item => item.report)?.report?.summary ?? '').replace(/\s+/g, ' ').slice(0, 160),
    read: `ticket/${ticket.id}` }
}
type Routed = { decision?: DecisionKind; reason: string; ticketId?: string | undefined; triggerIds?: readonly string[] }
const fromDecision = (decision: Decision) => ({ decision: decision.kind, reason: reasonText(decision.reason), ticketId: decision.ticketId })
/**
 * Carry out one routing decision as its Engine command, in a transaction of its own. `decided` holds the Triggers that this
 * call's earlier items decided, with the item that decided them.
 */
export function route(host: RouteHost, item: RouteItem, decided: ReadonlyMap<string, string>): Routed | { refused: string } {
  const note = item.note ? { note: item.note } : {}
  // A Trigger an earlier item decided went with that item's Decision, also as a member of its batch.
  const earlier = decided.get(item.trigger_id)
  if (earlier && item.kind === 'ignore') return { refused: `Decided in this call with ${earlier}, whose Decision took its batch` }
  switch (item.kind) {
    case 'accept': {
      const before = host.decisionOf(item.trigger_id)
      const decision = host.decide(item.trigger_id, { kind: 'accept', title: item.title!, scope: item.title!, reason: { code: 'explicitRouted' },
        acknowledgement: item.acknowledgement!, name: item.worktree_name!, ...note })
      // A Decision that created no ticket is the item's refusal; one that existed before keeps what it was accepted with.
      if (decision.kind !== 'accept' || !decision.ticketId) return { refused: `Ticket was not created: ${reasonText(decision.reason)}` }
      if (decision.id === before) {
        return { decision: 'accept', reason: `Already accepted as ${decision.ticketId}; title and acknowledgement unchanged`, ticketId: decision.ticketId }
      }
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'attach': {
      const ticket = host.quietly(() => host.attach(item.ticket_id!, item.trigger_id, item.note ?? undefined))
      return { reason: 'Attached: the ticket follows the trigger\'s thread and receives the trigger', ticketId: ticket.id }
    }
    // Through `decide`, so only a person's message the gate admits with explicit strength stops a ticket.
    case 'stop': {
      const decision = host.decide(item.trigger_id, { kind: 'stop', ticketId: item.ticket_id!, reason: item.reason || { code: 'humanStop' } })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
    case 'ignore': {
      const decision = host.decide(item.trigger_id, { kind: 'ignore', reason: item.reason! })
      return { ...fromDecision(decision), triggerIds: decision.triggerIds }
    }
  }
}
export interface RouteResult {
  trigger_id: string
  kind: RouteKind
  decision?: DecisionKind
  reason?: string
  ticket?: ReturnType<typeof ticketCard>
  refused?: string
}
/**
 * Run a whole call: decisions in order, each answered on its own. A refused or failed item does not stop the others; the
 * response preserves the input order and repeats each item's `trigger_id` and `kind`.
 */
export function executeRoute(host: RouteHost, input: unknown, options: RouteToolOptions = {}): { results: RouteResult[] } | { error: string } {
  const parsed = parseCall(input)
  if (!parsed.ok) return { error: parsed.error }
  const decided = new Map<string, string>()
  const results = parsed.items.map(item => {
    const head = { trigger_id: item.trigger_id, kind: item.kind }
    const problem = invalid(item, options)
    if (problem) return { ...head, refused: problem }
    try {
      const result = route(host, item, decided)
      if ('refused' in result) return { ...head, ...result }
      for (const id of result.triggerIds ?? []) if (!decided.has(id)) decided.set(id, item.trigger_id)
      const ticket = result.ticketId ? host.ticket(result.ticketId) : undefined
      return { ...head, ...(result.decision ? { decision: result.decision } : {}), reason: result.reason,
        ...(ticket ? { ticket: ticketCard(ticket) } : {}) }
    } catch (error) {
      if (error instanceof UserError) return { ...head, refused: error.message }
      return { ...head, refused: `Not recorded: ${error instanceof Error ? error.message : String(error)}; retry this item` }
    }
  })
  host.requestPass()
  return { results }
}
/** The tool definition an agent runtime would register. */
export const routeToolDefinition = {
  name: 'orchestrator_route',
  description: 'Route candidates, one item each by the card\'s trigger_id, in one call: accept an explicit request as a new ticket, '
    + 'attach a trigger to an existing ticket, stop a ticket on a person\'s stop message, or ignore a candidate that needs no ticket '
    + 'or stop, as dispatch says. Items run in order and each is answered on its own; a refused item leaves the others.',
} as const
export type { Outcome }
