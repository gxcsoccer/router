/** `orchestrator_route` as extracted: shape checks, per-item isolation, and the batch rules. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Lab } from '../src/lab/session.ts'
import { parseCall, executeRoute } from '../src/routing/route-tool.ts'

type Result = Record<string, unknown>
const run = (lab: Lab, items: unknown[]) => lab.route(items) as Result[]
const accept = (triggerId: string, title = '任务', extra: Record<string, unknown> = {}) =>
  ({ kind: 'accept', trigger_id: triggerId, title, worktree_name: 'task-one', acknowledgement: '收到', ...extra })

test('the call shape is strict: unknown fields, empty lists and too many items are rejected whole', () => {
  assert.equal('error' in parseCall({ decisions: [] })!, true)
  assert.equal('error' in parseCall({ decisions: Array.from({ length: 21 }, () => accept('t')) })!, true)
  assert.equal('error' in parseCall({ decisions: [accept('t')], extra: 1 })!, true)
  assert.equal('error' in parseCall({ decisions: [{ ...accept('t'), unknown: true }] })!, true)
  assert.equal('ok' in parseCall({ decisions: [accept('t')] })!, true)
})

test('field content is checked per kind, so one bad item leaves the rest running', () => {
  const lab = new Lab()
  const one = lab.receive({ text: '帮我查大阪机票' }).trigger
  const two = lab.receive({ text: '帮我改周报' }).trigger
  lab.tick()
  const results = run(lab, [
    { kind: 'accept', trigger_id: one.id, worktree_name: 'task-one', acknowledgement: '收到' },  // no title
    accept(two.id, '周报'),
  ])
  assert.match(String(results[0]!.refused), /accept needs title/)
  assert.equal(results[1]!.decision, 'accept')
  assert.equal(lab.tickets().length, 1, 'the good item still ran')
})

test('limits: note ≤ 30 words, acknowledgement ≤ 100 words, worktree name kebab-case', () => {
  const lab = new Lab()
  const { trigger } = lab.receive({ text: '帮我查大阪机票' })
  lab.tick()
  const longNote = Array.from({ length: 31 }, (_, index) => `word${index}`).join(' ')
  assert.match(String(run(lab, [accept(trigger.id, '机票', { note: longNote })])[0]!.refused), /at most 30/)
  assert.match(String(run(lab, [accept(trigger.id, '机票', { worktree_name: '大阪-机票' })])[0]!.refused), /kebab-case/)
  const manyWords = Array.from({ length: 101 }, (_, index) => `w${index}`).join(' ')
  assert.match(String(run(lab, [accept(trigger.id, '机票', { acknowledgement: manyWords })])[0]!.refused), /at most 100/)
})

test('an accept is idempotent, and its result repeats the trigger id and kind', () => {
  const lab = new Lab()
  const { trigger } = lab.receive({ text: '帮我查大阪机票' })
  lab.tick()
  const first = run(lab, [accept(trigger.id, '机票')])[0]!
  const again = run(lab, [accept(trigger.id, '机票')])[0]!
  assert.equal(first.kind, 'accept')
  assert.equal(first.trigger_id, trigger.id)
  assert.equal((again.ticket as Result).ticket_id, (first.ticket as Result).ticket_id)
  assert.match(String(again.reason), /Already accepted/)
})

test('a field the kind does not read is silently ignored (accept takes no reason)', () => {
  const lab = new Lab()
  const { trigger } = lab.receive({ text: '帮我查大阪机票' })
  lab.tick()
  const result = run(lab, [accept(trigger.id, '机票', { reason: '模型想写的原因' })])[0]!
  assert.equal(result.decision, 'accept')
  assert.match(String(result.reason), /Explicit request from an allowed sender/)
  assert.doesNotMatch(String(result.reason), /模型想写的原因/)
})

test('within one call, an accept claims its whole batch and a later ignore of it is refused locally', () => {
  const lab = new Lab()
  const one = lab.receive({ text: '帮我查大阪机票' }).trigger
  const two = lab.receive({ text: '帮我改周报' }).trigger
  lab.tick()
  const results = run(lab, [accept(one.id, '机票'), { kind: 'ignore', trigger_id: two.id, reason: '不需要' }])
  assert.equal(results[0]!.decision, 'accept')
  assert.match(String(results[1]!.refused), /Decided in this call/)
  assert.equal(lab.tickets().length, 1)
})

test('attach does not claim the trigger in the batch map, but the Engine still refuses a later ignore', () => {
  const lab = new Lab({ ownership: 'routed' })
  const first = lab.receive({ text: '帮我查大阪机票' }).trigger
  lab.tick()
  run(lab, [accept(first.id, '机票')])
  const ticketId = lab.tickets()[0]!.id
  const second = lab.receive({ text: '顺便看看酒店' }).trigger
  lab.tick()
  const results = run(lab, [{ kind: 'attach', trigger_id: second.id, ticket_id: ticketId },
    { kind: 'ignore', trigger_id: second.id, reason: '其实不需要' }])
  assert.equal(results[0]!.refused, undefined)
  // The tool's batch map does not know about the attach, so the item reaches the Engine; there the ticket now owns the
  // message, so `leftToWorkers` refuses it instead of recording a second Decision. The refusal is correct, only less local.
  assert.match(String(results[1]!.refused), /worker decides/)
  const decisions = lab.repo.decisions.byThread(lab.threadKey)
  assert.equal(decisions.filter(decision => decision.triggerIds.includes(second.id)).length, 1)
})

test('a refused Engine command is reported per item, not thrown', () => {
  const lab = new Lab({ ownership: 'thread' })
  const first = lab.receive({ text: '帮我查大阪机票' }).trigger
  lab.tick()
  run(lab, [accept(first.id, '机票')])
  const second = lab.receive({ text: '顺便看看酒店' }).trigger
  // No tick: the message was fanned out at intake, so no candidate exists and the worker owns it.
  const result = run(lab, [accept(second.id, '酒店')])[0]!
  assert.match(String(result.refused), /worker decides/)
  assert.equal(lab.tickets().length, 1)
})

test('the tool asks for a pass once per call', () => {
  const lab = new Lab()
  const { trigger } = lab.receive({ text: '帮我查大阪机票' })
  lab.tick()
  const before = lab.passes.requested
  executeRoute(lab.host, { decisions: [accept(trigger.id, '机票')] })
  assert.equal(lab.passes.requested, before + 1)
})
