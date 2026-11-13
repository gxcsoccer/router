/** 打印导出语料的统计与用户消息清单，用于挑选评测窗口与人工标注。 */
import { loadAime } from './aime.ts'

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : undefined
}
const path = arg('corpus') ?? process.env.AIME_CORPUS ?? `${process.env.HOME}/Downloads/Aime_用户发起对话_2026-09-30至2026-11-14.txt`
const messages = loadAime(path)
const body = messages.filter(message => !message.appendix)
const users = body.filter(message => message.role === 'user')
const byDate = new Map<string, number>()
for (const message of users) byDate.set(message.date, (byDate.get(message.date) ?? 0) + 1)
console.log(`messages ${body.length} · user ${users.length} · assistant ${body.length - users.length} · appendix ${messages.length - body.length}`)
console.log(`dates ${byDate.size} · ${[...byDate.entries()].map(([date, count]) => `${date}:${count}`).join(' ')}`)
const from = Number(arg('from') ?? 0)
const to = Number(arg('to') ?? users.length)
for (const [index, message] of users.slice(from, to).entries()) {
  const preview = message.text.replace(/\s+/g, ' ').slice(0, 100)
  console.log(`${String(from + index + 1).padStart(3)} ${message.date} ${message.at} ${preview}`)
}
