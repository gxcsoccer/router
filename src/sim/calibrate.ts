/** 用标注窗口校准级联的阈值：在 A 上选点，在 B 上验证。只比较"续接"这一种可拦截动作。 */
import { loadAime, turns } from './aime.ts'
import { LABELS } from './aime-labels.ts'
import { embeddingSimilarity } from '../routing/embed.ts'

const path = process.env.AIME_CORPUS ?? `${process.env.HOME}/Downloads/Aime_用户发起对话_2026-09-30至2026-11-14.txt`
const source = loadAime(path)

interface Point { score: number; margin: number; expected: string; best: string }
function points(setId: string): Point[] {
  const set = LABELS.find(item => item.id === setId)!
  const window = turns(source, set.fromTurn, set.toTurn)
  const known = new Map<string, string>()
  const out: Point[] = []
  for (const [index, turn] of window.entries()) {
    const label = set.labels[index]!
    if ((label.intent === 'continue' || label.intent === 'new') && known.size) {
      // 首判带上下文：上一两条消息往往说明了"回复到哪"，单看当前一句无法判断。
      const recent = window.slice(Math.max(0, index - 2), index).map(item => item.user.text).join(' ')
      const query = `${recent} ${turn.user.text}`
      const scores = [...known.entries()].map(([id, title]) => ({ id, score: embeddingSimilarity(query, title) }))
        .sort((a, b) => b.score - a.score)
      out.push({ score: scores[0]!.score, margin: scores[0]!.score - (scores[1]?.score ?? 0), best: scores[0]!.id,
        expected: label.intent === 'continue' ? label.of! : '__new__' })
    }
    if (label.task) known.set(label.task, set.tasks.find(task => task.id === label.task)!.title)
  }
  return out
}

function report(setId: string, threshold: number, margin: number) {
  const rows = points(setId)
  let hit = 0, wrong = 0, skipped = 0
  for (const point of rows) {
    const intercept = point.expected !== '__new__' && point.score >= threshold && point.margin >= margin
    if (!intercept) { skipped++; continue }
    if (point.best === point.expected) hit++
    else wrong++
  }
  return { hit, wrong, skipped }
}

for (const threshold of [0.14, 0.16, 0.18, 0.2, 0.22, 0.24, 0.26]) {
  for (const margin of [0.02, 0.04, 0.06]) {
    const a = report('window-a', threshold, margin)
    const b = report('window-b', threshold, margin)
    console.log(`t=${threshold} m=${margin} | A hit ${a.hit} wrong ${a.wrong} skip ${a.skipped} | B hit ${b.hit} wrong ${b.wrong} skip ${b.skipped}`)
  }
}
