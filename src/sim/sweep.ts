/**
 * Repeated LLM sampling for the personal-agent scenarios: runs the same conversation several times with fresh caches, then
 * reports the spread rather than one lucky run. Also prints which messages are unstable and what the model did when it failed.
 *
 *   node --experimental-transform-types --no-warnings src/sim/sweep.ts \
 *     --model deepseek-flash --repeat 3 --ownership routed \
 *     --scenarios personal-chat,many-tasks,twin-subjects,long-stream
 */
import { BY_ID, type Scenario } from './scenarios.ts'
import { oracle } from './router-policies.ts'
import { llmRouter, type LlmStats } from './llm.ts'
import { runScenario, type Ownership, type RunResult } from './run.ts'

const arg = (name: string, fallback: string): string => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1]! : fallback
}
const model = arg('model', 'deepseek-flash')
const repeats = Number(arg('repeat', '3'))
const ownership = arg('ownership', 'routed') as Ownership
const ids = arg('scenarios', 'personal-chat,many-tasks,twin-subjects,long-stream').split(',')
const cacheRoot = arg('cache', `src/sim/.cache/sweep/${model}`)

interface Sample { run: RunResult; stats: LlmStats }

function summarize(samples: Sample[]): {
  correct: number[]; safe: number[]; leaked: number[]; fragmented: number[]; tickets: number[]; swept: number[]; refused: number[]
  unseen: number[]; prompts: number; completions: number; reasoning: number; calls: number; repairs: number; invalid: number; ms: number
} {
  const pick = (fn: (sample: Sample) => number) => samples.map(fn)
  return {
    correct: pick(sample => sample.run.metrics.correct),
    safe: pick(sample => sample.run.metrics.safe),
    leaked: pick(sample => sample.run.metrics.leaked),
    fragmented: pick(sample => sample.run.metrics.fragmented),
    tickets: pick(sample => sample.run.metrics.tickets),
    swept: pick(sample => sample.run.metrics.swept),
    refused: pick(sample => sample.run.metrics.refused),
    unseen: pick(sample => sample.run.metrics.unseen),
    prompts: samples.reduce((sum, sample) => sum + sample.stats.promptTokens, 0),
    completions: samples.reduce((sum, sample) => sum + sample.stats.completionTokens, 0),
    reasoning: samples.reduce((sum, sample) => sum + sample.stats.reasoningTokens, 0),
    calls: samples.reduce((sum, sample) => sum + sample.stats.calls, 0),
    repairs: samples.reduce((sum, sample) => sum + sample.stats.repairs, 0),
    invalid: samples.reduce((sum, sample) => sum + sample.stats.invalid, 0),
    ms: samples.reduce((sum, sample) => sum + sample.stats.ms, 0),
  }
}
const stats = (values: number[]) => {
  const mean = values.reduce((a, b) => a + b, 0) / values.length
  return `${mean.toFixed(1)} (min ${Math.min(...values)}, max ${Math.max(...values)})`
}
const pct = (value: number, total: number) => `${Math.round((value / total) * 100)}%`

async function main(): Promise<void> {
  for (const id of ids) {
    const scenario = BY_ID[id] as Scenario | undefined
    if (!scenario) { console.log(`unknown scenario: ${id}`); continue }
    const total = scenario.messages.length
    const reference = await runScenario({ scenario, ownership, router: oracle, worker: 'diligent' })
    const samples: Sample[] = []
    for (let run = 0; run < repeats; run++) {
      const router = await llmRouter({ model, cacheDir: `${cacheRoot}/${id}-${ownership}-${run}` })
      const result = await runScenario({ scenario, ownership, router, worker: 'diligent' })
      samples.push({ run: result, stats: router.stats })
    }
    const summary = summarize(samples)
    console.log(`\n### ${scenario.id} · ${ownership} · ${model} · ${repeats} runs`)
    console.log(`messages ${total} · oracle ${reference.metrics.correct}/${total} · LLM strict ${stats(summary.correct)} · `
      + `safe ${stats(summary.safe)} · mean ${pct(summary.correct.reduce((a, b) => a + b, 0) / repeats, total)}`)
    console.log(`leaked ${stats(summary.leaked)} · fragmented ${stats(summary.fragmented)} · `
      + `tickets ${stats(summary.tickets)} (expected ${reference.metrics.expectedTasks}) · swept ${stats(summary.swept)} · `
      + `refused ${stats(summary.refused)} · unseen ${stats(summary.unseen)}`)
    console.log(`calls ${summary.calls} · repairs ${summary.repairs} · invalid ${summary.invalid} · `
      + `tokens ${summary.prompts}+${summary.completions} (reasoning ${summary.reasoning}) · ${(summary.ms / 1000).toFixed(1)}s`)

    // Which messages varied between runs.
    const unstable: string[] = []
    for (let index = 0; index < total; index++) {
      const outcomes = samples.map(sample => sample.run.rows[index]?.correct)
      if (!outcomes.every(value => value === outcomes[0])) unstable.push(`#${index + 1}`)
    }
    if (unstable.length) console.log(`unstable: ${unstable.join(' ')}`)

    // What went wrong in the weakest run.
    const weakest = [...samples].sort((a, b) => a.run.metrics.correct - b.run.metrics.correct)[0]!
    const failures = weakest.run.rows.filter(row => !row.correct)
    for (const row of failures) {
      console.log(`  ✗ #${row.index + 1} ${row.intent} 「${row.text}」 → ${row.decision ?? (row.seen ? 'attach' : 'unseen')}`
        + `${row.created ? ' 新票' : ''} · ${row.problem}${row.leakedTo.length ? ` · 串台 ${row.leakedTo.length}` : ''}`)
    }
  }
}

await main()
