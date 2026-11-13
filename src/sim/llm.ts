/**
 * A real-model router: DeepSeek plays the main Session. It sees exactly what the hosted router sees — the candidate card, the
 * batch, the related ticket cards and the recent conversation — and answers with `orchestrator_route` items, which are then
 * validated by the same `parseCall` the tool uses. Responses are cached on disk, so replays cost nothing.
 *
 * The key comes from DEEPSEEK_API_KEY or the `.env` beside the package; it is never logged.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { invalid, parseCall, type RouteItem } from '../routing/route-tool.ts'
import type { CandidateCard } from '../lab/assessor.ts'
import type { FollowUpNotice, RouterChoice, RouterContext, RouterPolicy } from './router-policies.ts'

const HERE = dirname(fileURLToPath(import.meta.url))
const CACHE = join(HERE, '.cache')

export interface LlmOptions {
  model?: string
  baseUrl?: string
  apiKey?: string
  cacheDir?: string
  temperature?: number
  maxTokens?: number
  /** Print one line per call, for tuning. */
  trace?: boolean
  /** `coding` keeps dsh-superagent's worktree-shaped ticket; `neutral` defines a ticket as any follow-up with a deliverable. */
  prompt?: 'coding' | 'neutral'
  /** Whether the router may answer a message inline instead of opening or ignoring a ticket. */
  allowAnswer?: boolean
  /** How many previous user messages the card carries. */
  history?: number
  /** Personal-agent deployments may not name a git worktree. */
  requireWorktreeName?: boolean
  /** Bypass the disk cache, so a timed run measures real calls. */
  fresh?: boolean
}

/** 个人助理版的系统提示：票 = 需要跟进、有交付物的事，不限于代码改动；纯问答走 answer。 */
const SYSTEM_NEUTRAL = `你是个人助理的任务路由器。你的唯一工作是判断一条用户消息属于哪件"事"，并给出路由决定。

"事"（票）指需要跟进、有交付物、要动手或要等结果的工作：调研、对比、写方案/文档/邮件、跑授权、审片、订票、约会议、整理数据……不要求是代码改动。

你会收到一张候选卡片：
- trigger_id：当前要决定的消息；它可能是同一批次里的某一条
- text：消息原文
- batch：同一批次里的其他消息（各自有 trigger_id 和 preview）
- task_index：最近的票（最多 12 张，未结束的优先、新的在前），每张只有 ticket_id / title / keywords / state
- history：最近的对话

规则：
1. 一条消息只归一件事。新任务用 accept，续接已有任务用 attach，能一句话答清楚的用 answer（不要用 ignore 把它无声丢掉），用户明确叫停用 stop；确实不需要任何回复时才用 ignore。
2. 只有消息明确指向某张票（引用、回复、同一对象的后续修改、明确提到那个改动）才 attach；主题相似不算——相似主题是新请求。
3. batch 里的每一条都要给出一个 item（逐条决定），否则整批会被第一条 accept 吞掉。
4. accept 需要 title（≤200 字，描述原始请求）与 acknowledgement（一句话，≤100 词）；worktree_name 可选，只有确实要改代码时才给（1–4 个英文小写单词）。
5. answer 需要 text（直接给用户的答复，≤100 词）。
6. attach / stop 需要 ticket_id；ignore 需要 reason。
7. 不要翻译、不要扩展范围、不要挑选实现方案。

每个 item 只能有这些字段（不要用 action / decision / type 代替 kind）：
{"kind":"accept","trigger_id":"...","title":"...","acknowledgement":"...","worktree_name":"可选"}
{"kind":"attach","trigger_id":"...","ticket_id":"..."}
{"kind":"answer","trigger_id":"...","text":"..."}
{"kind":"ignore","trigger_id":"...","reason":"..."}
{"kind":"stop","trigger_id":"...","ticket_id":"...","reason":"..."}

只输出 JSON：{"decisions":[...]}。不要 markdown 代码块，不要解释。`

export interface LlmStats {
  calls: number
  cached: number
  repairs: number
  invalid: number
  failed: number
  promptTokens: number
  completionTokens: number
  reasoningTokens: number
  /** Wall time spent in HTTP calls, milliseconds. */
  ms: number
}

const SYSTEM = `你是 dsh-superagent 的主 Session，只负责把用户消息路由成任务。你看不到代码库，也不要提出实现方案。

你会收到一张候选卡片：
- trigger_id：当前要决定的消息；它可能是同一批次里的某一条
- text：消息原文
- batch：同一批次里的其他消息（各自有 trigger_id 和 preview）
- related_tickets：该会话上最近的票（最多 8 张，未结束的优先、新的在前），含 ticket_id / title / state / preview
- history：最近的对话

规则：
1. 一条消息只归一个任务。新任务用 accept，续接已有任务用 attach，闲聊或无需动作用 ignore，用户明确叫停用 stop。
2. 只有消息明确指向某张票（引用、回复、同一对象的后续修改、明确提到那个改动）才 attach；主题相似不算——相似主题是新请求。
3. batch 里的每一条都要给出一个 item（逐条决定）。只决定一条会把整批并进那张票，几条无关请求会被吞成一张票。
4. accept 需要：title（≤200 字，描述原始请求，不加需求、不写验收标准）、worktree_name（1–4 个英文小写单词，kebab-case）、acknowledgement（一句话，≤100 词，说明要做的具体改动）。
5. attach 需要 ticket_id；stop 需要 ticket_id；ignore 需要 reason。
6. 不要翻译、不要扩展范围、不要挑选实现方案。

每个 item 只能有这些字段（不要输出别的字段，不要用 action / decision / type 代替 kind）：
{"kind":"accept","trigger_id":"...","title":"...","worktree_name":"...","acknowledgement":"..."}
{"kind":"attach","trigger_id":"...","ticket_id":"..."}
{"kind":"ignore","trigger_id":"...","reason":"..."}
{"kind":"stop","trigger_id":"...","ticket_id":"...","reason":"..."}

只输出 JSON：{"decisions":[...]}。不要 markdown 代码块，不要解释。`

const FOLLOW_UP_SYSTEM = `你是 dsh-superagent 的主 Session。这条用户消息已经到达下列任务，它们的 worker 会自己判断是否属于本任务；你只能做一件事：在用户**明确要求停止/取消/不用了**时停掉其中一张票。其它情况（新请求、提问、补充说明、闲聊）一律不处理。
只输出 JSON：{"decisions":[{"kind":"stop","trigger_id":"...","ticket_id":"...","reason":"..."}]}；不需要停止就输出 {"decisions":[]}。`

function loadKey(explicit?: string): string {
  if (explicit) return explicit
  if (process.env.DEEPSEEK_API_KEY) return process.env.DEEPSEEK_API_KEY
  for (const candidate of [join(process.cwd(), '.env'), join(HERE, '../../.env')]) {
    if (!existsSync(candidate)) continue
    for (const line of readFileSync(candidate, 'utf8').split('\n')) {
      const match = /^\s*DEEPSEEK_API_KEY\s*=\s*(.+?)\s*$/.exec(line)
      if (match) return match[1]!.replace(/^["']|["']$/g, '')
    }
  }
  throw new Error('DEEPSEEK_API_KEY is not set and no .env beside the package provides one')
}

/** Strip a markdown fence and parse the first JSON object. */
export function jsonOf(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) throw new Error('the answer carries no JSON object')
  return JSON.parse(trimmed.slice(start, end + 1))
}

export async function llmRouter(options: LlmOptions = {}): Promise<RouterPolicy & { stats: LlmStats }> {
  const model = options.model ?? 'deepseek-flash'
  const answerRule = '\n\n另外：能一句话答清楚的问题用 {"kind":"answer","trigger_id":"...","text":"..."} 直接回答，'
    + '不要用 ignore 静默丢掉；确实不需要回复才用 ignore。'
  const systemPrompt = options.prompt === 'neutral' ? SYSTEM_NEUTRAL
    : options.allowAnswer ? SYSTEM + answerRule : SYSTEM
  const historyLimit = options.history ?? 8
  const baseUrl = (options.baseUrl ?? 'https://api.deepseek.com').replace(/\/$/, '')
  const apiKey = loadKey(options.apiKey)
  const cacheDir = options.cacheDir ?? CACHE
  const temperature = options.temperature ?? 0
  const maxTokens = options.maxTokens ?? 1200
  const stats: LlmStats = { calls: 0, cached: 0, repairs: 0, invalid: 0, failed: 0, promptTokens: 0, completionTokens: 0, reasoningTokens: 0, ms: 0 }

  const complete = async (messages: { role: 'system' | 'user'; content: string }[]): Promise<string> => {
    const body = { model, messages, temperature, max_tokens: maxTokens }
    const key = createHash('sha256').update(JSON.stringify(body)).digest('hex').slice(0, 32)
    const file = join(cacheDir, `${key}.json`)
    if (!options.fresh && existsSync(file)) { stats.cached++; return (JSON.parse(readFileSync(file, 'utf8')) as { text: string }).text }
    let lastError: unknown
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        stats.calls++
        const started = Date.now()
        const response = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(90_000),
        })
        if (!response.ok) throw new Error(`HTTP ${response.status}: ${(await response.text()).slice(0, 200)}`)
        const payload = await response.json() as {
          choices?: { message?: { content?: string } }[]
          usage?: { prompt_tokens?: number; completion_tokens?: number; completion_tokens_details?: { reasoning_tokens?: number } }
        }
        stats.ms += Date.now() - started
        stats.promptTokens += payload.usage?.prompt_tokens ?? 0
        stats.completionTokens += payload.usage?.completion_tokens ?? 0
        stats.reasoningTokens += payload.usage?.completion_tokens_details?.reasoning_tokens ?? 0
        const text = payload.choices?.[0]?.message?.content ?? ''
        if (!text.trim()) throw new Error('empty answer')
        mkdirSync(cacheDir, { recursive: true })
        writeFileSync(file, JSON.stringify({ model, text }))
        if (options.trace) console.error(`llm ${model} ${stats.calls} ${text.length} chars`)
        return text
      } catch (error) {
        lastError = error
        await new Promise(resolve => setTimeout(resolve, 500 * (attempt + 1)))
      }
    }
    stats.failed++
    throw lastError instanceof Error ? lastError : new Error(String(lastError))
  }

  /**
   * Parse and field-check the answer. A shape error or a field its kind needs goes back to the model once; the second answer
   * is accepted only if every item passes both checks, so a malformed item never reaches the tool and leaves the Eval open.
   */
  interface Answer { kind: 'answer'; trigger_id: string; text: string }
  interface Parsed { routes: RouteItem[]; answers: Answer[] }
  /** Split `answer` items (a host action) from routing items (tool calls), and field-check both. */
  const parse = (raw: unknown): Parsed => {
    const decisions = (raw as { decisions?: unknown } | undefined)?.decisions
    if (!Array.isArray(decisions) || !decisions.length) throw new Error('decisions must be a non-empty array')
    const answers: Answer[] = []
    const routes: unknown[] = []
    for (const item of decisions) {
      if (item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'answer') {
        const answer = item as { trigger_id?: unknown; text?: unknown }
        if (typeof answer.trigger_id !== 'string' || !answer.trigger_id) throw new Error('answer needs trigger_id')
        if (typeof answer.text !== 'string' || !answer.text.trim()) throw new Error('answer needs text')
        answers.push({ kind: 'answer', trigger_id: answer.trigger_id, text: answer.text.trim() })
      } else routes.push(item)
    }
    let items: RouteItem[] = []
    if (routes.length) {
      const parsed = parseCall({ decisions: routes })
      if (!parsed.ok) throw new Error(parsed.error)
      const problem = parsed.items.map(item => invalid(item, { requireWorktreeName: options.requireWorktreeName })).find(Boolean)
      if (problem) throw new Error(problem)
      items = parsed.items
    }
    return { routes: items, answers }
  }
  const ask = async (messages: { role: 'system' | 'user'; content: string }[]): Promise<Parsed> => {
    let problem = ''
    try { return parse(tryJson(await complete(messages))) } catch (error) { problem = error instanceof Error ? error.message : String(error) }
    stats.repairs++
    const repaired = await complete([
      ...messages,
      { role: 'user', content: `你的上一次输出无法通过校验：${problem}。按系统提示里的字段名修正，只输出 JSON。` },
    ])
    try { return parse(tryJson(repaired)) } catch (error) {
      stats.invalid++
      throw new Error(`invalid routing call: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const choose = async (card: CandidateCard, ctx: RouterContext): Promise<RouterChoice[]> => {
    const peerIds = new Set<string>([card.trigger_id, ...(card.batch ?? []).map(peer => peer.trigger_id)])
    const messages = [
      { role: 'system' as const, content: systemPrompt },
      { role: 'user' as const, content: JSON.stringify({ history: historyLimit > 0 ? (ctx.history ?? []).slice(-historyLimit) : [],
        candidate: card, decide_now: ctx.text }, null, 2) },
    ]
    let parsed
    try {
      parsed = await ask(messages)
    } catch (error) {
      if (options.trace) console.error('llm fallback:', String(error).slice(0, 160))
      // Fail open on this item alone: start a task rather than drop the person's message.
      return [{ kind: 'accept', triggerId: card.trigger_id, title: ctx.text.replace(/\s+/g, ' ').slice(0, 40) }]
    }
    const choices: RouterChoice[] = [
      ...parsed.answers.map(answer => ({ kind: 'answer' as const,
        triggerId: peerIds.has(answer.trigger_id) ? answer.trigger_id : card.trigger_id, text: answer.text })),
      ...parsed.routes.map(item => {
      const triggerId = peerIds.has(item.trigger_id) ? item.trigger_id : card.trigger_id
      switch (item.kind) {
        case 'accept':
          return { kind: 'accept', triggerId, title: item.title!, ...item.worktree_name ? { worktreeName: item.worktree_name } : {},
            ...item.acknowledgement ? { acknowledgement: item.acknowledgement } : {} }
        case 'attach': return { kind: 'attach', triggerId, ticketId: item.ticket_id! }
        case 'stop': return { kind: 'stop', triggerId, ticketId: item.ticket_id!, reason: item.reason ?? '用户叫停' }
        case 'ignore': return { kind: 'ignore', triggerId, reason: item.reason ?? '不需要任务' }
      }
    }),
    ]
    return choices
  }

  const followUp = async (notice: FollowUpNotice, ctx: RouterContext): Promise<RouterChoice | undefined> => {
    // A follow-up may answer with an empty list, which the routing call's 1–20 rule would reject, so it has its own parse.
    void ctx
    let raw: unknown
    try {
      raw = jsonOf(await complete([
        { role: 'system', content: FOLLOW_UP_SYSTEM },
        { role: 'user', content: JSON.stringify({ message: notice.text, delivered_to: notice.delivered_to }, null, 2) },
      ]))
    } catch { return undefined }
    const decisions = (raw as { decisions?: unknown }).decisions
    if (!Array.isArray(decisions)) return undefined
    const stop = decisions.find((item): item is { kind: 'stop'; ticket_id: string; reason?: string } =>
      !!item && typeof item === 'object' && (item as { kind?: unknown }).kind === 'stop'
      && typeof (item as { ticket_id?: unknown }).ticket_id === 'string')
    return stop ? { kind: 'stop', triggerId: notice.trigger_id, ticketId: stop.ticket_id, reason: stop.reason ?? '用户叫停' } : undefined
  }

  return { id: `llm-${model}`, label: `LLM（${model}，真实模型）`, choose, followUp, stats }
}

function tryJson(text: string): unknown {
  try { return jsonOf(text) } catch { return undefined }
}
