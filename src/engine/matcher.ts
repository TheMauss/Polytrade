/** Cross-event matcher — finds mutually exclusive market pairs using embeddings. */

import { logger } from "../utils/logger.js";
import type { Event, Market } from "../clients/types.js";

// Lazy-loaded transformer pipeline
let embedPipeline: any = null;

async function getEmbedder() {
  if (!embedPipeline) {
    // Dynamic import to avoid loading at startup if not needed
    const { pipeline } = await import("@xenova/transformers");
    embedPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    logger.info("embedding_model_loaded");
  }
  return embedPipeline;
}

export class CrossEventMatcher {
  private similarityThreshold: number;
  private cache = new Map<string, Float32Array>();

  constructor(similarityThreshold = 0.65) {
    this.similarityThreshold = similarityThreshold;
  }

  async findExclusivePairs(
    events: Event[],
    maxPairs = 100,
  ): Promise<[Market, Market][]> {
    // Collect all markets with their event ID
    const items: { market: Market; eventId: string }[] = [];
    for (const event of events) {
      for (const market of event.markets) {
        items.push({ market, eventId: event.id });
      }
    }

    if (items.length < 2) return [];

    // Embed all questions
    const questions = items.map((i) => i.market.question);
    const embeddings = await this.embedTexts(questions);

    // Find high-similarity pairs from DIFFERENT events
    const pairs: { a: Market; b: Market; sim: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        // Skip same-event (handled by intra-event)
        if (items[i].eventId === items[j].eventId) continue;

        const sim = cosineSimilarity(embeddings[i], embeddings[j]);
        if (sim >= this.similarityThreshold) {
          if (likelyExclusive(items[i].market.question, items[j].market.question)) {
            pairs.push({ a: items[i].market, b: items[j].market, sim });
          }
        }
      }
    }

    // Sort by similarity, take top N
    pairs.sort((x, y) => y.sim - x.sim);
    const result = pairs.slice(0, maxPairs).map((p): [Market, Market] => [p.a, p.b]);

    if (result.length > 0) {
      logger.info({ count: result.length, topSim: pairs[0]?.sim }, "cross_event_pairs_found");
    }

    return result;
  }

  private async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const embedder = await getEmbedder();
    const results: Float32Array[] = [];

    for (const text of texts) {
      if (this.cache.has(text)) {
        results.push(this.cache.get(text)!);
        continue;
      }

      const output = await embedder(text, { pooling: "mean", normalize: true });
      const embedding = new Float32Array(output.data);
      this.cache.set(text, embedding);
      results.push(embedding);
    }

    return results;
  }

  clearCache(): void {
    this.cache.clear();
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
  }
  return dot; // Already normalized
}

/** Heuristic: do two questions describe mutually exclusive outcomes? */
function likelyExclusive(q1: string, q2: string): boolean {
  const a = q1.toLowerCase();
  const b = q2.toLowerCase();

  if (a === b) return false;

  // Both share exclusive keywords (different subjects, same competition)
  const keywords = ["win", "winner", "elected", "president", "nominee", "champion", "first", "next", "become"];
  const hasKeyword = keywords.some((kw) => a.includes(kw) && b.includes(kw));
  if (hasKeyword) return true;

  // Negation/opposition patterns
  const pairs: [string, string][] = [
    ["will", "won't"], ["yes", "no"], ["above", "below"],
    ["over", "under"], ["more", "less"], ["before", "after"],
  ];
  for (const [pos, neg] of pairs) {
    if ((a.includes(pos) && b.includes(neg)) || (a.includes(neg) && b.includes(pos))) {
      return true;
    }
  }

  return false;
}
