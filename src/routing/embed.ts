/**
 * A dependency-free hashed n-gram embedding, used as the cheap first stage of routing. It is **not** a neural embedding:
 * character 2–3 grams (and Latin words) are hashed into a fixed number of buckets, weighted, and L2-normalized, so cosine
 * similarity behaves like a smoothed overlap with graded confidence. The structure is the one Semantic Router uses
 * (encode → cosine → threshold → fall back), which is what the ablation is testing.
 */
const DIM = 512

function fnv1a(text: string): number {
  let hash = 0x811c9dc5
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash >>> 0
}

function grams(text: string): string[] {
  const clean = text.toLowerCase().replace(/[，。！？、：；"'“”‘’（）()\[\]{}<>《》!?.,:;\s]+/g, ' ').trim()
  const out: string[] = []
  for (const word of clean.split(' ')) if (/[a-z0-9]/.test(word)) out.push(`w:${word}`)
  for (const run of clean.match(/[\u4e00-\u9fff]+/g) ?? []) {
    for (let size = 2; size <= 3; size++) {
      for (let index = 0; index + size <= run.length; index++) out.push(run.slice(index, index + size))
    }
  }
  return out
}

const cache = new Map<string, Float64Array>()
export function embed(text: string): Float64Array {
  const hit = cache.get(text)
  if (hit) return hit
  const vector = new Float64Array(DIM)
  for (const gram of grams(text)) {
    const hash = fnv1a(gram)
    // Two buckets per gram soften collisions; the trigram bucket is weighted less than the bigram one.
    vector[hash % DIM]! += gram.length > 2 ? 0.5 : 1
    vector[(hash >>> 9) % DIM]! += gram.length > 2 ? 0.25 : 0.5
  }
  let norm = 0
  for (let index = 0; index < DIM; index++) norm += vector[index]! * vector[index]!
  norm = Math.sqrt(norm) || 1
  for (let index = 0; index < DIM; index++) vector[index] = vector[index]! / norm
  cache.set(text, vector)
  return vector
}

export function cosine(a: Float64Array, b: Float64Array): number {
  let sum = 0
  for (let index = 0; index < DIM; index++) sum += a[index]! * b[index]!
  return sum
}

export function embeddingSimilarity(a: string, b: string): number { return cosine(embed(a), embed(b)) }
