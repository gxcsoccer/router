/**
 * 用真实导出语料评测路由。
 *
 *   # 两个人工标注窗口：判分（strict / safe）与逐条明细
 *   node --experimental-transform-types --no-warnings src/sim/aime-eval.ts --mode windows --router llm
 *   node --experimental-transform-types --no-warnings src/sim/aime-eval.ts --mode windows --router oracle
 *
 *   # 真实流量切片：没有标注，只看结构（建票数、各类决策占比、扇出、未看到）
 *   node --experimental-transform-types --no-warnings src/sim/aime-eval.ts --mode stream --from 1 --to 60 --router llm
 *
 * 语料路径：--corpus，或 AIME_CORPUS，或 ~/Downloads 下的默认导出文件。
 */
import { loadAime, aimeScenario, streamScenario, turns } from './aime.ts'
import { LABELS } from './aime-labels.ts'
import { keyword, oracle } from './router-policies.ts'
import { llmRouter } from './llm.ts'
import { runScenario, type Ownership, type RunResult } from './run.ts'

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const corpus = arg('corpus') ?? process.env.AIME_CORPUS ?? `${process.env.HOME}/Downloads/Aime_用户发起对话_2026-09-30至2026-11-14.txt`
const mode = arg('mode', 'windows')!
const routerId = arg('router', 'llm')!
const ownership = arg('ownership', 'routed') as Ownership
const model = arg('model', 'deepseek-flash')!
const source = loadAime(corpus)

const routerFor = async (id: string) => {
  if (id === 'oracle') return oracle
  if (id === 'keyword') return keyword(2)
  if (id === 'llm') return llmRouter({ model })
  throw new Error(`unknown router: ${id}`)
}

function detail(run: RunResult): string {
  const lines = ['  # | 意图     | 消息 | 决策   | 收到 | 串台 | 结果']
  for (const row of run.rows) {
    const text = row.text.replace(/\s+/g, ' ').slice(0, 30)
    const decision = row.kind ?? (row.seen ? 'attach?' : '未看到')
    lines.push(`  ${String(row.index + 1).padStart(2)} | ${row.intent.padEnd(8)} | ${text.padEnd(30)} | ${String(decision).padEnd(6)}`
      + ` | ${row.recipients.length} | ${row.leakedTo.length ? '串台' : '—'} | ${row.correct ? '✓' : `✗ ${row.problem}`}`)
  }
  return lines.join('\n')
}

async function windows(): Promise<void> {
  for (const set of LABELS) {
    const scenario = aimeScenario(source, set)
    const reference = await runScenario({ scenario, ownership, router: oracle, worker: 'diligent' })
    const router = await routerFor(routerId)
    const run = await runScenario({ scenario, ownership, router, worker: 'diligent' })
    const m = run.metrics
    const kinds = new Map<string, number>()
    for (const row of run.rows) kinds.set(row.kind ?? (row.seen ? 'attach' : 'unseen'), (kinds.get(row.kind ?? (row.seen ? 'attach' : 'unseen')) ?? 0) + 1)
    console.log(`\n### ${set.id} · ${set.title} · ${ownership} · ${routerId}`)
    console.log(`消息 ${m.messages} · oracle ${reference.metrics.correct}/${m.messages} · ${routerId} strict ${m.correct}/${m.messages} · `
      + `safe ${m.safe}/${m.messages} · 串台 ${m.leaked} · 碎片 ${m.fragmented} · tickets ${m.tickets}/${m.expectedTasks}`)
    console.log(`决策分布 ${[...kinds.entries()].map(([kind, count]) => `${kind}:${count}`).join(' ')}`)
    console.log(detail(run))
    if ('stats' in router) {
      const stats = (router as { stats: { calls: number; repairs: number; promptTokens: number; completionTokens: number; ms: number } }).stats
      console.log(`LLM calls ${stats.calls} · repairs ${stats.repairs} · tokens ${stats.promptTokens}+${stats.completionTokens} · ${(stats.ms / 1000).toFixed(1)}s`)
    }
  }
}

async function stream(): Promise<void> {
  const from = Number(arg('from', '1'))
  const to = Number(arg('to', '60'))
  const scenario = streamScenario(source, from, to)
  const router = await routerFor(routerId)
  // 真实流量切片没有任务标注，worker 不能靠"跨任务就 handback"来模拟；否则每条消息都会被退回，
  // 造成 handedBackHere 的假象。这里让 worker 全部收下，只看路由结构。
  const run = await runScenario({ scenario, ownership, router, worker: 'silent', stepMs: Number(arg('step', '300000')) })
  const kinds = new Map<string, number>()
  for (const row of run.rows) {
    const kind = row.kind ?? (row.seen ? 'attach' : 'unseen')
    kinds.set(kind, (kinds.get(kind) ?? 0) + 1)
  }
  const m = run.metrics
  console.log(`\n### Aime 真实流量 ${from}–${to} · ${ownership} · ${routerId} · ${m.messages} 条用户消息`)
  console.log(`决策分布 ${[...kinds.entries()].sort((a, b) => b[1] - a[1]).map(([kind, count]) => `${kind}:${count}`).join(' ')}`)
  console.log(`tickets ${m.tickets} · 平均扇出 ${m.meanFanout.toFixed(2)} · 最大扇出 ${m.maxFanout} · 未看到 ${m.unseen} · 拒绝 ${m.refused} · swept ${m.swept}`)
  // 话题密集度：有多少条消息带链接或附件，这类通常是一个新委托而不是追问。
  const linked = turns(source, from, to).filter(turn => /(https?:\/\/|〔附件)/.test(turn.user.text)).length
  console.log(`带链接/附件 ${linked}/${m.messages} · 平均每条用户消息 ${(m.messages / Math.max(1, new Set(run.rows.map(row => row.task)).size)).toFixed(1)}`)
  if ('stats' in router) {
    const stats = (router as { stats: { calls: number; repairs: number; promptTokens: number; completionTokens: number; ms: number } }).stats
    console.log(`LLM calls ${stats.calls} · repairs ${stats.repairs} · tokens ${stats.promptTokens}+${stats.completionTokens} · ${(stats.ms / 1000).toFixed(1)}s`)
  }
}

if (mode === 'windows') await windows()
else if (mode === 'stream') await stream()
else throw new Error(`unknown mode: ${mode}`)
