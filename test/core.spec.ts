/** Invariants of the extracted core, driven through the lab harness. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { reasonText } from '../src/core/index.ts'
import { Lab } from '../src/lab/session.ts'

const accept = (title: string, extra: Record<string, unknown> = {}) => ({
  kind: 'accept', title, worktree_name: 'task-one', acknowledgement: 'On it', ...extra,
})

test('an accept creates one Ticket that owns its Trigger and follows its Thread', () => {
  const lab = new Lab()
  const { trigger } = lab.receive({ text: '帮我查一下下周去大阪的机票' })
  lab.tick()
  const results = lab.route([accept('大阪机票调研', { trigger_id: trigger.id })]) as Record<string, unknown>[]
  assert.equal(results.length, 1)
  const first = results[0]!
  assert.equal(first.decision, 'accept')
  assert.ok(first.ticket, 'the result carries the ticket card')
  const ticket = lab.tickets()[0]!
  assert.equal(ticket.title, '大阪机票调研')
  assert.deepEqual(ticket.origin.triggerIds, [trigger.id])
  assert.equal(ticket.mandate.scope, '大阪机票调研', 'a routed accept takes the title as its scope')
  assert.equal(ticket.mandate.strength, 'explicit')
  assert.deepEqual(lab.repo.threads.get(lab.threadKey)!.subscriptions, [ticket.id])
  // The acknowledgement the tool passed is queued for the Channel the person wrote on.
  assert.equal(lab.outbox.list().length, 1)
  assert.equal(lab.outbox.list()[0]!.kind, 'acknowledgement')
})

test('an accept is idempotent per Trigger', () => {
  const lab = new Lab()
  const { trigger } = lab.receive({ text: '把周报模板改成本周' })
  lab.tick()
  const first = (lab.route([accept('周报模板', { trigger_id: trigger.id })]) as Record<string, unknown>[])[0]!
  const again = (lab.route([accept('另一个标题', { trigger_id: trigger.id })]) as Record<string, unknown>[])[0]!
  assert.equal(again.ticket && (again.ticket as Record<string, unknown>).ticket_id, (first.ticket as Record<string, unknown>).ticket_id)
  assert.match(String(again.reason), /Already accepted/)
  assert.equal(lab.tickets().length, 1, 'no second ticket')
})

test('a stop needs an explicit message; an inferred one degrades to ignore', () => {
  const explicit = new Lab()
  const first = explicit.receive({ text: '帮我写封道歉邮件' }).trigger
  explicit.tick()
  const ticket = (explicit.route([accept('道歉邮件', { trigger_id: first.id })]) as Record<string, unknown>[])[0]!
  const ticketId = (ticket.ticket as Record<string, unknown>).ticket_id as string
  const stop = explicit.receive({ text: '算了邮件先不写了' }).trigger
  explicit.tick()
  const stopped = (explicit.route([{ kind: 'stop', trigger_id: stop.id, ticket_id: ticketId, reason: '人类叫停' }]) as Record<string, unknown>[])[0]!
  assert.equal(stopped.decision, 'stop')
  assert.equal(explicit.ticket(ticketId)!.ended?.outcome, 'stopped')

  const inferred = new Lab()
  const request = inferred.receive({ text: '帮我写封道歉邮件' }).trigger
  inferred.tick()
  inferred.route([accept('道歉邮件', { trigger_id: request.id })])
  const ticketId2 = inferred.tickets()[0]!.id
  const message = inferred.receive({ text: '算了先不写了', addressed: null }).trigger
  inferred.tick()
  const result = (inferred.route([{ kind: 'stop', trigger_id: message.id, ticket_id: ticketId2 }]) as Record<string, unknown>[])[0]!
  assert.equal(result.decision, 'ignore')
  assert.match(String(result.reason), /explicit/)
  assert.equal(inferred.ticket(ticketId2)!.ended, undefined, 'an inferred stop ends nothing')
})

test('thread ownership: a message on a subscribed Thread goes to its worker, never to the router', () => {
  const lab = new Lab({ ownership: 'thread' })
  const first = lab.receive({ text: '帮我查一下大阪的机票' }).trigger
  lab.tick()
  lab.route([accept('大阪机票', { trigger_id: first.id })])
  const second = lab.receive({ text: '顺便看看难波的酒店' }).trigger
  lab.tick()
  // No candidate: intake fanned the message out to the ticket that subscribes to the thread.
  assert.equal(lab.card(second.id), undefined)
  assert.deepEqual(lab.disposition(second.id)!.fanout, [lab.tickets()[0]!.id])
  assert.deepEqual(lab.ticketsHolding(second.id), [lab.tickets()[0]!.id])
  // The router is locked out: every routing decision but stop is refused with `workerDecides`.
  const refused = (lab.route([accept('酒店', { trigger_id: second.id })]) as Record<string, unknown>[])[0]!
  assert.match(String(refused.refused), /worker decides/)
  const attach = (lab.route([{ kind: 'attach', trigger_id: second.id, ticket_id: lab.tickets()[0]!.id }]) as Record<string, unknown>[])[0]!
  assert.match(String(attach.refused), /worker decides/)
})

test('routed ownership: the same message reaches the router and can be attached or accepted', () => {
  const lab = new Lab({ ownership: 'routed' })
  const first = lab.receive({ text: '帮我查一下大阪的机票' }).trigger
  lab.tick()
  lab.route([accept('大阪机票', { trigger_id: first.id })])
  const ticketId = lab.tickets()[0]!.id
  const second = lab.receive({ text: '顺便看看难波的酒店' }).trigger
  lab.tick()
  assert.ok(lab.card(second.id), 'the router sees it')
  assert.equal(lab.disposition(second.id)!.fanout.length, 0, 'no automatic fan-out')
  const attached = (lab.route([{ kind: 'attach', trigger_id: second.id, ticket_id: ticketId }]) as Record<string, unknown>[])[0]!
  assert.equal(attached.refused, undefined)
  assert.deepEqual(lab.ticketsHolding(second.id), [ticketId])
  assert.equal(lab.ticket(ticketId)!.undelivered.length > 0, true, 'the worker gets it as an Input')
})

test('one Eval batches a Thread\'s pending Triggers, and one accept decides the whole batch', () => {
  const lab = new Lab()
  const one = lab.receive({ text: '帮我查大阪机票' }).trigger
  const two = lab.receive({ text: '帮我改一下周报模板' }).trigger
  lab.tick()
  const card = lab.card(two.id)!
  assert.equal(card.trigger_id, two.id, 'the card\'s primary is the newest Trigger of the batch')
  assert.equal(card.batch?.length, 1)
  const result = (lab.route([accept('大阪机票', { trigger_id: one.id })]) as Record<string, unknown>[])[0]!
  const ticket = lab.ticket((result.ticket as Record<string, unknown>).ticket_id as string)!
  assert.deepEqual(ticket.origin.triggerIds.sort(), [one.id, two.id].sort(), 'the unrelated message is swept into the ticket')
  assert.ok(lab.decisionOf(two.id), 'and is marked decided')
  assert.equal(lab.tickets().length, 1)
})

test('a message a worker handed back cannot be attached back to it', () => {
  const lab = new Lab({ ownership: 'thread' })
  const first = lab.receive({ text: '帮我查一下大阪的机票' }).trigger
  lab.tick()
  lab.route([accept('大阪机票', { trigger_id: first.id })])
  const ticketId = lab.tickets()[0]!.id
  const second = lab.receive({ text: '帮我改一下周报模板' }).trigger
  lab.deliver(ticketId)
  assert.equal(lab.handback(ticketId, second.id, '不是这张票的事'), true)
  lab.tick()
  assert.ok(lab.card(second.id), 'the handed-back message is queued for a fresh Eval')
  const refused = (lab.route([{ kind: 'attach', trigger_id: second.id, ticket_id: ticketId }]) as Record<string, unknown>[])[0]!
  assert.match(String(refused.refused), /handed/i)
})

test('an ended Ticket resumes on attach under its unchanged Mandate', () => {
  const lab = new Lab({ ownership: 'routed' })
  const first = lab.receive({ text: '帮我查一下大阪的机票' }).trigger
  lab.tick()
  lab.route([accept('大阪机票', { trigger_id: first.id })])
  const ticketId = lab.tickets()[0]!.id
  lab.deliver(ticketId)
  lab.report(ticketId, { state: 'ready', summary: '查好了' })
  assert.equal(lab.ticket(ticketId)!.ended?.outcome, 'completed')
  const again = lab.receive({ text: '大阪那趟我还是想住难波' }).trigger
  lab.tick()
  const attached = (lab.route([{ kind: 'attach', trigger_id: again.id, ticket_id: ticketId }]) as Record<string, unknown>[])[0]!
  assert.equal(attached.refused, undefined)
  const resumed = lab.ticket(ticketId)!
  assert.equal(resumed.ended, undefined, 'it resumed')
  assert.ok(resumed.inputs.some(input => input.kind === 'resumed'))
  assert.equal(resumed.mandate.scope, '大阪机票', 'the same Mandate')
})

test('a person-stopped Ticket takes no resume', () => {
  const lab = new Lab({ ownership: 'routed' })
  const first = lab.receive({ text: '帮我查一下大阪的机票' }).trigger
  lab.tick()
  lab.route([accept('大阪机票', { trigger_id: first.id })])
  const ticketId = lab.tickets()[0]!.id
  const stop = lab.receive({ text: '算了不查了' }).trigger
  lab.tick()
  lab.route([{ kind: 'stop', trigger_id: stop.id, ticket_id: ticketId }])
  const again = lab.receive({ text: '还是查一下吧' }).trigger
  lab.tick()
  const refused = (lab.route([{ kind: 'attach', trigger_id: again.id, ticket_id: ticketId }]) as Record<string, unknown>[])[0]!
  assert.match(String(refused.refused), /stopped/i)
})

test('reason codes stay machine readable', () => {
  const lab = new Lab()
  const { trigger } = lab.receive({ text: '随便聊聊' })
  lab.tick()
  const result = (lab.route([{ kind: 'ignore', trigger_id: trigger.id, reason: '不需要任务' }]) as Record<string, unknown>[])[0]!
  assert.equal(result.decision, 'ignore')
  const decision = lab.decisionOf(trigger.id)!
  assert.equal(reasonText(decision.reason), '不需要任务')
  assert.equal(decision.strength, 'explicit')
})

test('a failed attach leaves the Eval open and locks the whole Thread', () => {
  const lab = new Lab({ ownership: 'routed' })
  const first = lab.receive({ text: '帮我写封道歉邮件' }).trigger
  lab.tick()
  lab.route([accept('道歉邮件', { trigger_id: first.id })])
  const ticketId = lab.tickets()[0]!.id
  const stop = lab.receive({ text: '算了不写了' }).trigger
  lab.tick()
  lab.route([{ kind: 'stop', trigger_id: stop.id, ticket_id: ticketId }])
  // The stop's let-go requeues the message the stopped ticket owned but never took up.
  const orphan = lab.receive({ text: '邮件语气再软一点' }).trigger
  lab.tick()
  const card = lab.card(orphan.id)!
  assert.ok(card, 'the orphan is queued again')
  // Attaching it back to the stopped ticket fails, and the Eval stays in progress.
  const refused = (lab.route([{ kind: 'attach', trigger_id: orphan.id, ticket_id: ticketId }]) as Record<string, unknown>[])[0]!
  assert.match(String(refused.refused), /stopped/i)
  assert.ok(lab.repo.threads.get(lab.threadKey)!.evaluating, 'the Eval did not finish')
  // The Thread stays locked: the next message cannot even start an Eval until the stuck one ends or expires.
  const next = lab.receive({ text: '帮我看看 PR 42' }).trigger
  lab.tick()
  assert.equal(lab.card(next.id), undefined, 'no candidate for the new message')
  assert.deepEqual(lab.repo.threads.get(lab.threadKey)!.pending, [next.id], 'it waits behind the stuck Eval')
  assert.deepEqual(lab.repo.threads.get(lab.threadKey)!.evaluating!.triggerIds, [orphan.id], 'the orphan still holds the Eval')
})
