/**
 * 消融实验的"变体"：每个变体只改一处，对照同一批语料与同一模型。
 *
 * 借鉴的机制：
 * - Semantic Router / RouteLLM 的"快路由 + 置信阈值 + 回退"：`cascade`（规则先判，拿不准再问模型）。
 * - MemGPT/Letta 的分层记忆：`cardStyle: 'index'` 把 8 张全量票卡换成 12 条"任务指纹"，把上下文留给对话。
 * - Mem0 的关键词+实体多信号检索：`keywordsOf` 从标题抽取指纹，供 index 与级联匹配用。
 * - 真实语料暴露的"回答出口"：`allowAnswer` 让模型用 `answer` 直接答，而不是 `ignore` 掉。
 * - 去 coding 化：`prompt: 'neutral'` + `requireWorktreeName: false`。
 */
import type { RouterChoice, RouterContext, RouterPolicy } from './router-policies.ts'
import type { CandidateCard } from '../lab/assessor.ts'
import { keywordsOf } from '../lab/assessor.ts'
import { embeddingSimilarity } from '../routing/embed.ts'
import type { LlmOptions } from './llm.ts'
import { llmRouter } from './llm.ts'
import type { RunOptions } from './run.ts'

export interface Variant {
  id: string
  label: string
  /** What changed against v0. */
  change: string
  llm: LlmOptions
  run: Pick<RunOptions, 'cardStyle' | 'requireWorktreeName'>
  cascade?: boolean
  /** Which first stage the cascade uses: exact keyword hits, or the hashed n-gram embedding with a calibrated threshold. */
  firstStage?: 'keyword' | 'embedding'
  answer?: boolean
}

const STOP = /算了|先不|不写了|取消|停一下|不用了/
const GREETING = /^(谢谢|谢了|好的|好|嗯+|ok|hello|hi|hey|在吗)[!！。.\s]*$/i

/** One ticket as the cascade sees it, for either card shape. */
function ticketsOf(card: CandidateCard): { ticketId: string; title: string; keywords: string[] }[] {
  if (card.related_tickets) return card.related_tickets.map(ticket => ({ ticketId: ticket.ticket_id, title: ticket.title, keywords: keywordsOf(ticket.title) }))
  return (card.task_index ?? []).map(ticket => ({ ticketId: ticket.ticket_id, title: ticket.title, keywords: ticket.keywords }))
}
function hits(text: string, ticket: { title: string; keywords: string[] }): number {
  const words = new Set([...keywordsOf(text), ...text.split(/\s+/)])
  return ticket.keywords.filter(keyword => words.has(keyword)).length
}

/**
 * The cheap first stage: greet/ack, stop phrases and an unambiguous single-ticket match are decided without a model call.
 * Everything else falls through, which is the "Chain" pattern: act only when the fast stage is confident.
 */
export function cascade(inner: RouterPolicy, options: { answer: boolean }): RouterPolicy {
  return {
    id: `${inner.id}-cascade`,
    label: `${inner.label} + 级联`,
    choose(card: CandidateCard, ctx: RouterContext): ReturnType<RouterPolicy['choose']> {
      const text = ctx.text.trim()
      const ranked = ticketsOf(card).map(ticket => ({ ticket, score: hits(text, ticket) })).sort((a, b) => b.score - a.score)
      const best = ranked[0]
      if (GREETING.test(text) || text.length <= 2) {
        return options.answer ? { kind: 'answer', text: '好的。' } : { kind: 'ignore', reason: '寒暄' }
      }
      if (STOP.test(text) && best && best.score > 0) return { kind: 'stop', ticketId: best.ticket.ticketId, reason: '用户叫停' }
      if (best && best.score >= 2 && (!ranked[1] || best.score > ranked[1].score)) {
        return { kind: 'attach', ticketId: best.ticket.ticketId }
      }
      return inner.choose(card, ctx)
    },
    ...inner.followUp ? { followUp: inner.followUp } : {},
  }
}

/**
 * The same cascade with the hashed n-gram embedding as its first stage. The query carries the last two user messages,
 * because a follow-up like "回复到 issue 里" only means something next to what preceded it. Threshold and margin were
 * calibrated on window A and validated on window B (14 continuation candidates, 0 wrong intercepts).
 */
export function embeddingCascade(inner: RouterPolicy, options: { answer: boolean; threshold?: number; margin?: number }): RouterPolicy {
  const threshold = options.threshold ?? 0.14
  const margin = options.margin ?? 0.02
  return {
    id: `${inner.id}-embed`,
    label: `${inner.label} + 向量级联`,
    choose(card: CandidateCard, ctx: RouterContext): ReturnType<RouterPolicy['choose']> {
      const text = ctx.text.trim()
      const tickets = ticketsOf(card)
      if (GREETING.test(text) || text.length <= 2) {
        return options.answer ? { kind: 'answer', text: '好的。' } : { kind: 'ignore', reason: '寒暄' }
      }
      if (STOP.test(text) && tickets.length) {
        const ranked = tickets.map(ticket => ({ ticket, score: embeddingSimilarity(text, ticket.title) })).sort((a, b) => b.score - a.score)
        if (ranked[0]!.score > 0.05) return { kind: 'stop', ticketId: ranked[0]!.ticket.ticketId, reason: '用户叫停' }
      }
      if (!tickets.length) return inner.choose(card, ctx)
      const query = `${(ctx.history ?? []).slice(-2).join(' ')} ${text}`
      const ranked = tickets.map(ticket => ({ ticket, score: embeddingSimilarity(query, ticket.title) })).sort((a, b) => b.score - a.score)
      const best = ranked[0]!
      const second = ranked[1]
      if (best.score >= threshold && best.score - (second?.score ?? 0) >= margin) {
        return { kind: 'attach', ticketId: best.ticket.ticketId }
      }
      return inner.choose(card, ctx)
    },
    ...inner.followUp ? { followUp: inner.followUp } : {},
  }
}

export const VARIANTS: Variant[] = [
  { id: 'v0', label: 'v0 基线', change: '原样：coding 提示词、8 张全量票卡、无 answer、无级联、8 条历史',
    llm: { prompt: 'coding' }, run: {} },
  { id: 'v1', label: 'v1 回答出口', change: '+ answer：允许直接回答，不再 silent ignore',
    llm: { prompt: 'coding', allowAnswer: true }, run: {}, answer: true },
  { id: 'v2', label: 'v2 去 coding 化', change: '任务定义改为"有交付物的事"，worktree_name 可选，+ answer',
    llm: { prompt: 'neutral', allowAnswer: true, requireWorktreeName: false }, run: { requireWorktreeName: false }, answer: true },
  { id: 'v3', label: 'v3 级联', change: '规则先判（寒暄/叫停/唯一命中），拿不准再问模型',
    llm: { prompt: 'coding' }, run: {}, cascade: true },
  { id: 'v3e', label: 'v3e 向量级联', change: '级联首判从关键词换成哈希 n-gram embedding（带上下文）',
    llm: { prompt: 'coding' }, run: {}, cascade: true, firstStage: 'embedding' },
  { id: 'v8e', label: 'v8e 去 coding + answer + 向量级联', change: 'v8 的首判换成 embedding',
    llm: { prompt: 'neutral', allowAnswer: true, requireWorktreeName: false }, run: { requireWorktreeName: false }, cascade: true, firstStage: 'embedding', answer: true },
  { id: 'v4', label: 'v4 任务指纹卡', change: '8 张全量票卡 → 12 条 title+keywords 任务指纹',
    llm: { prompt: 'coding' }, run: { cardStyle: 'index' } },
  { id: 'v6', label: 'v6 无历史', change: '卡片不带对话历史（8 → 0）',
    llm: { prompt: 'coding', history: 0 }, run: {} },
  { id: 'v8', label: 'v8 去 coding + 回答出口 + 级联', change: 'v2 + 级联（保留全量票卡）',
    llm: { prompt: 'neutral', allowAnswer: true, requireWorktreeName: false }, run: { requireWorktreeName: false }, cascade: true, answer: true },
  { id: 'v7', label: 'v7 组合', change: 'v2 + 级联 + 任务指纹卡',
    llm: { prompt: 'neutral', allowAnswer: true, requireWorktreeName: false }, run: { cardStyle: 'index', requireWorktreeName: false }, cascade: true, answer: true },
]

/** Build the policy and the run options for one variant. */
export async function buildVariant(variant: Variant, model: string, fresh = false): Promise<{ router: RouterPolicy; run: Variant['run']; stats: ReturnType<typeof llmRouter> extends Promise<infer R> ? (R extends { stats: infer S } ? S : never) : never }> {
  const base = await llmRouter({ model, ...variant.llm, ...fresh ? { fresh: true } : {} })
  const router = variant.cascade
    ? (variant.firstStage === 'embedding'
      ? embeddingCascade(base, { answer: variant.answer ?? false })
      : cascade(base, { answer: variant.answer ?? false }))
    : base
  return { router, run: variant.run, stats: base.stats }
}
