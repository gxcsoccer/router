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

test('the card shows at most eight tickets, newest first, so older tasks fall off', async () => {
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
  const { trigger } = lab.receive({ text: '回到第一个任务' })
  lab.tick()
  const card = lab.card(trigger.id)!
  assert.equal(card.related_tickets.length, 8, 'the card is capped at eight')
  assert.equal(card.tickets_total, 10, 'but it says how many there are')
  assert.equal(card.related_tickets.some(ticket => ticket.title === '任务 1'), false, 'the oldest is not on the card')
  assert.equal(card.related_tickets.some(ticket => ticket.title === '任务 10'), true, 'the newest is')
})
