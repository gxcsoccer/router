/** 导出语料解析器：用一小段同构文本测试，不引入真实聊天内容。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAime, turns, userMessages, aimeScenario } from '../src/sim/aime.ts'

const SAMPLE = `你与 Aime 的对话导出（排除主动推送）

导言里提到“待核对附录”不应结束正文。

======================================================================
2026-09-30
======================================================================

[09:46:58] 你

你能做啥？

[09:47:13] Aime

可以把事情交给我。

[09:51:24] 你

看看这个 group

[09:51:46] Aime

我查一下

======================================================================
2026-10-01
======================================================================

[11:17:11] 你

Hello.

[11:17:32] Aime

Hey.

待核对附录：以下消息归属不清。

[23:00:00] 你

附录里的一条
`

test('parses dates, roles and keeps the appendix out of the body', () => {
  const messages = parseAime(SAMPLE)
  const body = messages.filter(message => !message.appendix)
  assert.equal(body.length, 6)
  assert.equal(userMessages(messages).length, 3)
  assert.equal(body.filter(message => message.role === 'assistant').length, 3)
  assert.equal(messages.at(-1)!.appendix, true)
  assert.equal(body[0]!.date, '2026-09-30')
  assert.equal(body[0]!.text, '你能做啥？')
  assert.equal(body.at(-1)!.date, '2026-10-01')
})

test('a turn keeps its replies, and a labelled window becomes a scenario', () => {
  const messages = parseAime(SAMPLE)
  const window = turns(messages, 2, 3)
  assert.equal(window.length, 2)
  assert.equal(window[0]!.replies.length, 1)
  const scenario = aimeScenario(messages, {
    id: 'sample', title: 'sample', fromTurn: 1, toTurn: 3,
    tasks: [{ id: 'a', title: '能力询问' }, { id: 'b', title: '看仓库' }],
    closeOn: { b: 2 },
    labels: [
      { turn: 1, intent: 'chitchat' },
      { turn: 2, intent: 'new', task: 'b' },
      { turn: 3, intent: 'chitchat' },
    ],
  })
  assert.equal(scenario.messages.length, 3)
  assert.equal(scenario.messages[1]!.text, '看看这个 group')
  assert.equal(scenario.tasks.find(task => task.id === 'b')!.closeAt, 2)
  assert.equal(scenario.threadModel, 'single')
})
