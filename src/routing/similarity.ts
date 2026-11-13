/** Dependency-free text similarity for the cheap routing stages: CJK bigrams and Latin words, overlap coefficient. */
const PUNCT = /[，。！？、：；"'“”‘’（）()\[\]{}<>《》!?.,:;\s]+/g
const NOISE = new Set(['帮我', '我一', '一下', '看看', '这个', '那个', '一个', '还是', '就是', '可以', '我们', '你们', '什么', '怎么'])

export function units(text: string): Set<string> {
  const clean = text.toLowerCase().replace(PUNCT, ' ').trim()
  const out = new Set<string>()
  for (const word of clean.split(' ')) if (/[a-z0-9]/.test(word)) out.add(word)
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    if (run.length === 1) out.add(run)
    for (let index = 0; index + 1 < run.length; index++) {
      const gram = run.slice(index, index + 2)
      if (!NOISE.has(gram)) out.add(gram)
    }
  }
  return out
}

/** Shared units over the smaller set, so a short follow-up that reuses one topic word still looks related. */
export function similarity(a: string, b: string): number {
  const left = units(a), right = units(b)
  if (!left.size || !right.size) return 0
  let shared = 0
  for (const unit of left) if (right.has(unit)) shared++
  return shared / Math.min(left.size, right.size)
}

/**
 * Split a burst before it becomes one atomic Eval: the first run of consecutive messages that stay similar is evaluated
 * now, and the rest wait for the next pass. Unrelated messages therefore never share a batch.
 */
export function splitBatches<T extends { text: string }>(messages: readonly T[], threshold = 0.15): readonly T[] {
  if (messages.length < 2) return messages
  let end = 1
  while (end < messages.length && similarity(messages[end - 1]!.text, messages[end]!.text) >= threshold) end++
  return messages.slice(0, end)
}
