/**
 * The lab's Assessor: it keeps the candidate each Eval asks about and projects the same card dsh-superagent sends the main
 * Session (`candidateCard` in `src/app/links.ts`), minus the GitHub/Feishu source-link resolution and the PR/issue reference
 * lookup. The card is the router's entire view: the trigger text, the rest of its batch, and at most eight related tickets,
 * open ones first and newest first.
 */
import { threadKey, type Assessor, type Candidate, type Ticket } from '../core/index.ts'
import { ticketCard } from '../routing/route-tool.ts'

export type CandidateCard = ReturnType<typeof candidateCard>

/**
 * The card's ticket list: the eight most recent, plus up to four older ones whose title shares a keyword with the message
 * (`recall: 'keyword'`). The recent window alone loses task 9 and older; the keyword recall is the cheap "archive lookup".
 */
export function relatedTickets(tickets: readonly Ticket[], query = '') {
  const order = [...tickets].sort((a, b) => Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1)
  const recent = order.slice(0, 8)
  const words = new Set(keywordsOf(query))
  const recalled = query
    ? order.slice(8).filter(ticket => keywordsOf(ticket.title).some(keyword => words.has(keyword))).slice(0, 4)
    : []
  return {
    related_tickets: [
      ...recent.map(ticketCard),
      ...recalled.map(ticket => ({ ...ticketCard(ticket), recall: 'keyword' as const })),
    ],
    tickets_total: tickets.length,
    ...recalled.length ? { recalled } : {},
  }
}

/** Card shapes the lab can hand the router: the full ticket cards, or a compact task index (title + keywords). */
export type CardStyle = 'full' | 'index'

const NOISE = new Set(['帮我', '我一', '一下', '看看', '这个', '那个', '一个', '还是', '就是', '可以', '我们', '你们', '什么', '怎么'])
/** Cheap task fingerprint: CJK bigrams and Latin words from a title, most useful first. */
export function keywordsOf(text: string): string[] {
  const clean = text.toLowerCase().replace(/[，。！？、：；"'“”‘’（）()\[\]{}<>《》!?.,:;\s]+/g, ' ').trim()
  const out: string[] = []
  for (const word of clean.split(' ')) if (/[a-z0-9]/.test(word)) out.push(word)
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let index = 0; index + 1 < run.length; index++) {
      const gram = run.slice(index, index + 2)
      if (!NOISE.has(gram)) out.push(gram)
    }
  }
  return [...new Set(out)].slice(0, 6)
}

export function candidateCard(candidate: Candidate, style: CardStyle = 'full') {
  const primary = candidate.triggers.at(-1)!
  const others = candidate.triggers.filter(trigger => trigger.id !== primary.id)
  return {
    kind: 'candidate' as const,
    trigger_id: primary.id,
    from: primary.actor.id,
    thread: threadKey(primary.threads[0]!),
    at: primary.at,
    text: primary.text.length <= 4000 ? primary.text : `${primary.text.slice(0, 4000)}…`,
    strength: candidate.strength,
    ...others.length
      ? { batch: others.map(trigger => ({ trigger_id: trigger.id, from: trigger.actor.id, at: trigger.at,
        preview: trigger.text.replace(/\s+/g, ' ').slice(0, 160), read: `trigger/${trigger.id}` })) }
      : {},
    ...style === 'index'
      ? { task_index: [...candidate.tickets]
        .sort((a, b) => Number(!a.ended) === Number(!b.ended) ? b.createdAt.localeCompare(a.createdAt) : a.ended ? 1 : -1)
        .slice(0, 12)
        .map(ticket => ({ ticket_id: ticket.id, title: ticket.title, keywords: keywordsOf(ticket.title),
          state: ticketCard(ticket).state })),
        tickets_total: candidate.tickets.length }
      : relatedTickets(candidate.tickets, primary.text),
    next_action: candidate.strength === 'explicit'
      ? 'Route it with orchestrator_route as dispatch says: accept, attach, stop or ignore.'
      : 'Ignore it with orchestrator_route if the card shows it touches no enabled rule; else assess it with orchestrator_eval, orchestrator_eval_read, then orchestrator_eval_decide.',
  }
}

/** Holds the candidates the Engine queued, so the lab can act as the main Session reading them. */
export class QueueAssessor implements Assessor {
  readonly queued = new Map<string, Candidate>()
  request(candidate: Candidate): void { this.queued.set(candidate.evalId, candidate) }
  release(evalId: string): void { this.queued.delete(evalId) }
  /** The candidate that holds `triggerId`, if any. */
  for(triggerId: string): Candidate | undefined {
    for (const candidate of this.queued.values()) if (candidate.triggers.some(trigger => trigger.id === triggerId)) return candidate
    return undefined
  }
  all(): Candidate[] { return [...this.queued.values()] }
  clear(): void { this.queued.clear() }
}
