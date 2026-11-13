/**
 * 消融实验：同一批语料、同一个模型，每次只改一处，对比效果 / 准确度 / 速度。
 *
 *   node --experimental-transform-types --no-warnings src/sim/ablate.ts --model deepseek-flash
 *   node --experimental-transform-types --no-warnings src/sim/ablate.ts --variants v0,v7 --out docs/ablation.md
 */
import { loadAime } from './aime.ts'
import { LABELS } from './aime-labels.ts'
import { aimeScenario } from './aime.ts'
import { personalChat, manyTasks, type Scenario } from './scenarios.ts'
import { oracle } from './router-policies.ts'
import { runScenario, type RunResult } from './run.ts'
import { VARIANTS, buildVariant, type Variant } from './variants.ts'

const arg = (name: string, fallback?: string): string | undefined => {
  const index = process.argv.indexOf(`--${name}`)
  return index >= 0 ? process.argv[index + 1] : fallback
}
const corpus = arg('corpus') ?? process.env.AIME_CORPUS ?? `${process.env.HOME}/Downloads/Aime_用户发起对话_2026-09-30至2026-11-14.txt`
const model = arg('model', 'deepseek-flash')!
const only = new Set((arg('variants') ?? VARIANTS.map(variant => variant.id).join(',')).split(','))
const out = arg('out')
const fresh = process.argv.includes('--fresh')
const repeat = Number(arg('repeat', '1'))
const onlyScenarios = arg('scenarios')?.split(',')
const source = loadAime(corpus)

const SCENARIOS: Record<string, Scenario> = {
  'aime-a': aimeScenario(source, LABELS[0]!),
  'aime-b': aimeScenario(source, LABELS[1]!),
  'many-tasks': manyTasks,
  'personal-chat': personalChat,
}
/** 每个变体跑哪些场景：只跑能体现它改动的那几个，控制调用量。 */
const MATRIX: Record<string, string[]> = {
  v0: ['aime-a', 'aime-b', 'many-tasks', 'personal-chat'],
  v1: ['aime-a', 'aime-b'],
  v2: ['aime-a', 'aime-b'],
  v3: ['aime-a', 'aime-b'],
  v3e: ['aime-a', 'aime-b'],
  v8e: ['aime-a', 'aime-b'],
  v4: ['many-tasks'],
  v6: ['aime-a', 'aime-b'],
  v8: ['aime-a', 'aime-b'],
  v7: ['aime-a', 'aime-b', 'many-tasks', 'personal-chat'],
}

interface Cell { variant: Variant; scenario: string; sample: number; run: RunResult; calls: number; prompts: number; completions: number; ms: number; repairs: number }
const cells: Cell[] = []
const ceiling = new Map<string, number>()

for (const id of Object.keys(SCENARIOS)) {
  const reference = await runScenario({ scenario: SCENARIOS[id]!, ownership: 'routed', router: oracle, worker: 'diligent' })
  ceiling.set(id, reference.metrics.correct)
}

for (const variant of VARIANTS.filter(item => only.has(item.id))) {
  for (const scenarioId of (MATRIX[variant.id] ?? []).filter(id => !onlyScenarios || onlyScenarios.includes(id))) {
    const scenario = SCENARIOS[scenarioId]!
    for (let sample = 0; sample < repeat; sample++) {
      const { router, run, stats } = await buildVariant(variant, model, fresh)
      const result = await runScenario({ scenario, ownership: 'routed', router, worker: 'diligent', ...run })
      cells.push({ variant, scenario: scenarioId, sample, run: result, calls: stats.calls, prompts: stats.promptTokens,
        completions: stats.completionTokens, ms: stats.ms, repairs: stats.repairs })
      const m = result.metrics
      console.log(`${variant.id} ${scenarioId}#${sample + 1} strict ${m.correct}/${m.messages} safe ${m.safe} leak ${m.leaked} tickets ${m.tickets} `
        + `answered ${m.answered} calls ${stats.calls} tok ${stats.promptTokens}+${stats.completionTokens} ${(stats.ms / 1000).toFixed(0)}s`)
    }
  }
}

const table = (rows: string[][], header: string[]): string => {
  const widths = header.map((cell, index) => Math.max(cell.length, ...rows.map(row => (row[index] ?? '').length)))
  const line = (cells: string[]) => cells.map((cell, index) => cell.padEnd(widths[index]!)).join(' | ')
  return [line(header), widths.map(width => '-'.repeat(width)).join('-+-'), ...rows.map(line)].join('\n')
}

const byVariant = new Map<string, Cell[]>()
for (const cell of cells) byVariant.set(cell.variant.id, [...byVariant.get(cell.variant.id) ?? [], cell])
const lines: string[] = ['# 消融实验', '', `模型 \`${model}\`；语料：Aime 真实窗口 + 合成场景；routed 归属。`, '']
for (const [id, list] of byVariant) {
  const variant = list[0]!.variant
  const messages = list.reduce((sum, cell) => sum + cell.run.metrics.messages, 0)
  const strict = list.reduce((sum, cell) => sum + cell.run.metrics.correct, 0)
  const safe = list.reduce((sum, cell) => sum + cell.run.metrics.safe, 0)
  const perScenario = new Map<string, number[]>()
  for (const cell of list) perScenario.set(cell.scenario, [...perScenario.get(cell.scenario) ?? [], cell.run.metrics.correct])
  const leak = list.reduce((sum, cell) => sum + cell.run.metrics.leaked, 0)
  const answered = list.reduce((sum, cell) => sum + cell.run.metrics.answered, 0)
  const calls = list.reduce((sum, cell) => sum + cell.calls, 0)
  const prompts = list.reduce((sum, cell) => sum + cell.prompts, 0)
  const completions = list.reduce((sum, cell) => sum + cell.completions, 0)
  const ms = list.reduce((sum, cell) => sum + cell.ms, 0)
  lines.push(`## ${variant.id} · ${variant.label}`, '', `改动：${variant.change}`, '',
    table([
      ['严格正确', `${strict}/${messages}`, `${Math.round((strict / Math.max(1, messages)) * 100)}%`],
      ['分场景严格', [...perScenario.entries()].map(([id, values]) => `${id} ${values.join('/')}`).join(' · '), ''],
      ['安全送达', `${safe}/${messages}`, `${Math.round((safe / Math.max(1, messages)) * 100)}%`],
      ['串台', `${leak}`, ''],
      ['内联回答', `${answered}`, ''],
      ['模型调用', `${calls}`, ''],
      ['token', `${prompts}+${completions}`, ''],
      ['耗时', `${(ms / 1000).toFixed(0)}s`, ''],
    ], ['指标', '值', '占比']), '',
    table(list.map(cell => [cell.scenario, `#${cell.sample + 1}`, `${cell.run.metrics.correct}/${cell.run.metrics.messages}`,
      `${cell.run.metrics.safe}`, `${cell.run.metrics.leaked}`, `${cell.run.metrics.tickets}`, `${cell.run.metrics.answered}`, `${cell.calls}`,
      `${cell.prompts}+${cell.completions}`, `${(cell.ms / 1000).toFixed(0)}s`]),
    ['场景', '样本', '严格', '安全', '串台', 'tickets', 'answer', '调用', 'token', '耗时']), '')
}
lines.push('## 上界', '', table([...ceiling.entries()].map(([id, correct]) => [id, `${correct}/${SCENARIOS[id]!.messages.length}`]), ['场景', 'oracle']))
console.log('\n' + table([...byVariant].map(([id, list]) => {
  const messages = list.reduce((sum, cell) => sum + cell.run.metrics.messages, 0)
  return [id, `${list.reduce((sum, cell) => sum + cell.run.metrics.correct, 0)}/${messages}`,
    `${list.reduce((sum, cell) => sum + cell.run.metrics.safe, 0)}`,
    `${list.reduce((sum, cell) => sum + cell.run.metrics.leaked, 0)}`,
    `${list.reduce((sum, cell) => sum + cell.run.metrics.answered, 0)}`,
    `${list.reduce((sum, cell) => sum + cell.calls, 0)}`,
    `${list.reduce((sum, cell) => sum + cell.prompts, 0)}`,
    `${(list.reduce((sum, cell) => sum + cell.ms, 0) / 1000).toFixed(0)}s`]
}), ['variant', 'strict', 'safe', 'leak', 'answer', 'calls', 'prompt tok', 'time']))
if (out) {
  const { writeFileSync } = await import('node:fs')
  writeFileSync(out, lines.join('\n') + '\n')
  console.log(`\nwrote ${out}`)
}
