/**
 * Regression tests for the personal-agent findings. They pin the mechanism's behaviour, not a model's: a perfect router
 * (`oracle`) is used wherever the point is the mechanism, and the word-matching router only where the point is that grouping
 * needs semantics.
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { personalChat, githubLike, burst, burstSplit } from '../src/sim/scenarios.ts'
import { oracle, oraclePerTrigger, keyword, alwaysNew } from '../src/sim/router-policies.ts'
import { runScenario, type Ownership } from '../src/sim/run.ts'
import type { RouterPolicy } from '../src/sim/router-policies.ts'

const metrics = async (scenario: typeof personalChat, ownership: Ownership, router: RouterPolicy) =>
  (await runScenario({ scenario, ownership, router, worker: 'diligent' })).metrics

test('single chat + thread ownership: the router loses the conversation after the first accept', async () => {
  const m = await metrics(personalChat, 'thread', oracle)
  assert.ok(m.correct <= 3, `only the first messages can be right, got ${m.correct}`)
  assert.equal(m.leaked, 14, '14 of 16 messages reach a ticket of another task')
  assert.ok(m.unseen >= 11, 'the router never sees most messages')
  assert.ok(m.meanFanout > 2, 'one message fans out to every live and ended ticket')
  assert.equal(m.stops, 1, 'a stop still works, but only through the follow-up notice')
})

test('single chat + routed ownership: the same router reaches every message', async () => {
  const m = await metrics(personalChat, 'routed', oracle)
  assert.equal(m.correct, 16)
  assert.equal(m.unseen, 0)
  assert.equal(m.leaked, 0)
  assert.equal(m.tickets, 4, 'one ticket per task, no fragments')
})

test('thread ownership is coherent when the client opens one thread per task', async () => {
  const m = await metrics(githubLike, 'thread', oracle)
  assert.equal(m.correct, 16)
  assert.equal(m.leaked, 0)
  assert.ok(m.unseen >= 11, 'but the router is bypassed: subscriptions do the grouping')
})

test('an Eval batch is atomic: once unrelated requests are batched, no routing decision can split them', async () => {
  const single = await metrics(burst, 'routed', oracle)
  assert.equal(single.tickets, 1)
  assert.equal(single.swept, 2, 'the first accept takes the whole batch as its origin')
  // Deciding every item does not help: the first accept already accepted the peers, so their items are idempotent no-ops.
  const perTrigger = await metrics(burst, 'routed', oraclePerTrigger)
  assert.equal(perTrigger.tickets, 1)
  assert.equal(perTrigger.swept, 2)
  // The durable fix is not batching them: an arrival one pass apart keeps the three requests apart.
  const split = await metrics(burstSplit, 'routed', oracle)
  assert.equal(split.tickets, 3)
  assert.equal(split.swept, 0)
})

test('ignoring a batch peer before the accept shrinks the batch, which is the only router-side lever', async () => {
  // In the single chat, a stop requeues a message that never reached its worker; it then rides into the next Eval.
  assert.equal((await metrics(personalChat, 'routed', oracle)).swept, 1)
  assert.equal((await metrics(personalChat, 'routed', oraclePerTrigger)).swept, 0, 'the orphan is ignored before the accept')
})

test('grouping is semantic: word matching is far below a perfect router, and opening a ticket per message is worst', async () => {
  const perfect = await metrics(personalChat, 'routed', oracle)
  const words = await metrics(personalChat, 'routed', keyword(2))
  const perMessage = await metrics(personalChat, 'routed', alwaysNew)
  assert.ok(words.correct < perfect.correct, 'word matching cannot follow paraphrases')
  assert.ok(words.correct > perMessage.correct, 'but it still beats opening a ticket per message')
  assert.ok(perMessage.fragmented >= 7, 'the per-message baseline fragments the tasks')
})

test('a greeting must not resume a finished task', async () => {
  const run = await runScenario({ scenario: githubLike, ownership: 'thread', router: oracle, worker: 'diligent' })
  assert.equal(run.metrics.spuriousResumes, 1, 'a "谢谢" on a completed task\'s thread resumes it')
})

test('the card keeps the eight most recent tickets and recalls older ones by keyword', async () => {
  const { Lab } = await import('../src/lab/session.ts')
  const lab = new Lab({ ownership: 'routed' })
  for (let index = 0; index < 10; index++) {
    lab.advance(30_000)
    const { trigger } = lab.receive({ text: `第 ${index + 1} 个任务` })
    lab.tick()
    lab.route([{ kind: 'accept', trigger_id: trigger.id, title: `任务 ${index + 1}`, worktree_name: `task-${index + 1}`,
      acknowledgement: '收到' }])
  }
  lab.advance(30_000)
  const { trigger } = lab.receive({ text: '回到第一个任务，发票报销' })
  lab.tick()
  const card = lab.card(trigger.id)!
  const recent = card.related_tickets.filter(ticket => !ticket.recall)
  const recalled = card.related_tickets.filter(ticket => ticket.recall === 'keyword')
  assert.equal(recent.length, 8, 'the recent window stays eight')
  assert.ok(recalled.length > 0 && recalled.length <= 4, 'older matches are recalled, capped at four')
  assert.ok(recalled.some(ticket => ticket.title === '任务 1'), 'the oldest task is reachable again')
  assert.equal(card.tickets_total, 10)
})

test('a query with no keyword overlap gets no recall, only the recent eight', async () => {
  const { Lab } = await import('../src/lab/session.ts')
  const lab = new Lab({ ownership: 'routed' })
  for (let index = 0; index < 10; index++) {
    lab.advance(30_000)
    const { trigger } = lab.receive({ text: `第 ${index + 1} 个任务` })
    lab.tick()
    lab.route([{ kind: 'accept', trigger_id: trigger.id, title: `任务 ${index + 1}`, worktree_name: `task-${index + 1}`,
      acknowledgement: '收到' }])
  }
  lab.advance(30_000)
  const { trigger } = lab.receive({ text: 'zzz' })
  lab.tick()
  assert.equal(lab.card(trigger.id)!.related_tickets.length, 8)
})

test("acceptBatch: 'primary' keeps the rest of a batch out of the new ticket", async () => {
  const { Lab } = await import('../src/lab/session.ts')
  const lab = new Lab({ ownership: 'routed', acceptBatch: 'primary' })
  const first = lab.receive({ text: '帮我查大阪机票' }).trigger
  const second = lab.receive({ text: '帮我改周报' }).trigger
  const third = lab.receive({ text: '帮我写道歉邮件' }).trigger
  lab.tick()
  lab.route([{ kind: 'accept', trigger_id: first.id, title: '大阪机票', worktree_name: 'osaka', acknowledgement: '收到' }])
  assert.equal(lab.tickets().length, 1)
  assert.deepEqual(lab.tickets()[0]!.origin.triggerIds, [first.id], 'only the decided Trigger joined')
  assert.equal(lab.repo.threads.get(lab.threadKey)!.evaluating, undefined)
  assert.deepEqual([...lab.repo.threads.get(lab.threadKey)!.pending].sort(), [second.id, third.id].sort())
  lab.tick()
  lab.route([{ kind: 'accept', trigger_id: second.id, title: '周报', worktree_name: 'weekly', acknowledgement: '收到' }])
  lab.tick()
  lab.route([{ kind: 'accept', trigger_id: third.id, title: '道歉邮件', worktree_name: 'apology', acknowledgement: '收到' }])
  assert.equal(lab.tickets().length, 3)
  assert.ok(lab.tickets().every(ticket => ticket.origin.triggerIds.length === 1))
})

test('a splitter keeps unrelated messages out of one Eval', async () => {
  const { Lab } = await import('../src/lab/session.ts')
  const { splitBatches } = await import('../src/routing/similarity.ts')
  const lab = new Lab({ ownership: 'routed', batchSplitter: splitBatches })
  const first = lab.receive({ text: '帮我查一下大阪机票' }).trigger
  const second = lab.receive({ text: '大阪机票要周三出发' }).trigger
  const third = lab.receive({ text: '帮我改周报模板' }).trigger
  lab.tick()
  const thread = lab.repo.threads.get(lab.threadKey)!
  assert.deepEqual(thread.evaluating!.triggerIds, [first.id, second.id], 'the related pair shares one Eval')
  assert.deepEqual(thread.pending, [third.id], 'the unrelated message waits for the next Eval')
})

test('the hashed embedding ranks a related title above an unrelated one', async () => {
  const { embeddingSimilarity } = await import('../src/routing/embed.ts')
  const related = embeddingSimilarity('大阪机票要周三出发', '大阪机票与酒店调研')
  const unrelated = embeddingSimilarity('大阪机票要周三出发', '周报模板调整')
  assert.ok(related > unrelated + 0.1, `${related} vs ${unrelated}`)
})

test('the vector cascade attaches an obvious continuation without calling the model', async () => {
  const { embeddingCascade } = await import('../src/sim/variants.ts')
  const { Lab } = await import('../src/lab/session.ts')
  const lab = new Lab({ ownership: 'routed' })
  const first = lab.receive({ text: '帮我查一下大阪机票' }).trigger
  lab.tick()
  lab.route([{ kind: 'accept', trigger_id: first.id, title: '大阪机票与酒店调研', worktree_name: 'osaka', acknowledgement: '收到' }])
  const second = lab.receive({ text: '大阪机票要周三出发' }).trigger
  lab.tick()
  const card = lab.card(second.id)!
  let called = false
  const inner = { id: 'inner', label: 'inner', choose: () => { called = true; return { kind: 'accept' as const, title: 'x' } } }
  const policy = embeddingCascade(inner, { answer: false })
  const choice = await policy.choose(card, { text: '大阪机票要周三出发', task: 'x', intent: 'continue', taskTitle: () => 'x',
    ticketsFor: () => [], taskOfTicket: () => undefined, history: ['帮我查一下大阪机票'] })
  assert.equal(Array.isArray(choice) ? choice[0]!.kind : choice.kind, 'attach')
  assert.equal(called, false, 'the model was not consulted')
})

test('acceptBatch primary lets three accepts in one call create three tickets', async () => {
  const { Lab } = await import('../src/lab/session.ts')
  const lab = new Lab({ ownership: 'routed', acceptBatch: 'primary' })
  const first = lab.receive({ text: '帮我查大阪机票' }).trigger
  const second = lab.receive({ text: '帮我改周报' }).trigger
  const third = lab.receive({ text: '帮我写道歉邮件' }).trigger
  lab.tick()
  const accept = (triggerId: string, title: string, name: string) => ({ kind: 'accept', trigger_id: triggerId, title,
    worktree_name: name, acknowledgement: '收到' })
  const results = lab.route([accept(first.id, '大阪机票', 'osaka'), accept(second.id, '周报', 'weekly'), accept(third.id, '道歉邮件', 'apology')]) as Record<string, unknown>[]
  assert.equal(results.length, 3)
  assert.ok(results.every(result => result.decision === 'accept'), 'every item accepted')
  assert.equal(lab.tickets().length, 3, 'one ticket each')
  assert.ok(lab.tickets().every(ticket => ticket.origin.triggerIds.length === 1))
})
