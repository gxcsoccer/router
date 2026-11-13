/** 打印窗口内完整用户消息与助手回复摘要，用于人工标注。 */
import { loadAime, windowMessages } from './aime.ts'
const arg = (name: string): string | undefined => { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : undefined }
const path = arg('corpus') ?? process.env.AIME_CORPUS ?? `${process.env.HOME}/Downloads/Aime_用户发起对话_2026-09-30至2026-11-14.txt`
const load = loadAime(path)
const from = Number(arg('from') ?? 0), to = Number(arg('to') ?? 20)
const users = load.filter(message => !message.appendix && message.role === 'user')
const first = users[from]!, last = users[to - 1]!
const turns = windowMessages(load, { id: 'dump', title: 'dump', from: first.index, to: last.index + 1 })
const width = Number(arg('width') ?? '260')
for (const [index, turn] of turns.entries()) {
  console.log(`\n[${from + index + 1}] ${turn.user.date} ${turn.user.at} 你：${turn.user.text}`)
  for (const reply of turn.replies.slice(0, 2)) {
    const text = reply.text.replace(/\s+/g, ' ').slice(0, width)
    console.log(`    Aime：${text}${reply.text.length > width ? '…' : ''}`)
  }
}
