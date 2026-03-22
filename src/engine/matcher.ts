/**
 * Cross-event matcher — finds mutually exclusive market pairs.
 *
 * Two-layer approach:
 * 1. Embeddings prefilter: fast cosine similarity to find CANDIDATE pairs
 * 2. LLM verification: Claude confirms logical mutual exclusivity
 */

import Anthropic from "@anthropic-ai/sdk";
import { logger } from "../utils/logger.js";
import type { Event, Market } from "../clients/types.js";

// Lazy-loaded transformer pipeline
let embedPipeline: any = null;

async function getEmbedder() {
  if (!embedPipeline) {
    const { pipeline } = await import("@xenova/transformers");
    embedPipeline = await pipeline("feature-extraction", "Xenova/all-MiniLM-L6-v2");
    logger.info("embedding_model_loaded");
  }
  return embedPipeline;
}

export class CrossEventMatcher {
  private similarityThreshold: number;
  private embeddingCache = new Map<string, Float32Array>();
  private llmCache = new Map<string, boolean>(); // "marketA_id|marketB_id" → exclusive?
  private anthropic: Anthropic | null = null;

  constructor(similarityThreshold = 0.55) {
    this.similarityThreshold = similarityThreshold;
    // Initialize Anthropic client if API key is available
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (apiKey) {
      this.anthropic = new Anthropic({ apiKey });
      logger.info("llm_verifier_enabled");
    } else {
      logger.warn("llm_verifier_disabled_no_api_key_falling_back_to_embeddings_only");
    }
  }

  async findExclusivePairs(
    events: Event[],
    maxPairs = 100,
  ): Promise<[Market, Market][]> {
    // Collect all markets with event context
    const items: { market: Market; eventId: string }[] = [];
    for (const event of events) {
      for (const market of event.markets) {
        items.push({ market, eventId: event.id });
      }
    }

    if (items.length < 2) return [];

    // Step 1: Embedding prefilter — find candidate pairs
    const candidates = await this.embeddingPrefilter(items);
    logger.info({ candidates: candidates.length }, "embedding_candidates_found");

    if (candidates.length === 0) return [];

    // Step 2: LLM verification — confirm mutual exclusivity
    const verified = await this.llmVerify(candidates);
    logger.info({ verified: verified.length, candidates: candidates.length }, "llm_verified_pairs");

    // Sort by similarity, take top N
    return verified.slice(0, maxPairs);
  }

  /**
   * Step 1: Fast embedding prefilter.
   * Finds market pairs from DIFFERENT events with high semantic similarity.
   * This is cheap (local model) but has false positives.
   */
  private async embeddingPrefilter(
    items: { market: Market; eventId: string }[],
  ): Promise<{ a: Market; b: Market; sim: number }[]> {
    const questions = items.map((i) => i.market.question);
    const embeddings = await this.embedTexts(questions);

    const candidates: { a: Market; b: Market; sim: number }[] = [];

    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        // Skip same-event (handled by intra-event detector)
        if (items[i].eventId === items[j].eventId) continue;

        const sim = cosineSimilarity(embeddings[i], embeddings[j]);
        if (sim >= this.similarityThreshold) {
          candidates.push({ a: items[i].market, b: items[j].market, sim });
        }
      }
    }

    // Sort by similarity descending — verify best candidates first
    candidates.sort((x, y) => y.sim - x.sim);
    return candidates;
  }

  /**
   * Step 2: LLM verification via Claude.
   * Sends candidate pairs to Claude Haiku for cheap, accurate logical reasoning.
   * Cost: ~$0.005-0.01 per pair. Cached to avoid re-asking.
   */
  private async llmVerify(
    candidates: { a: Market; b: Market; sim: number }[],
  ): Promise<[Market, Market][]> {
    // If no API key, fall back to all candidates (embedding-only mode)
    if (!this.anthropic) {
      return candidates.map((c) => [c.a, c.b]);
    }

    const verified: [Market, Market][] = [];

    // Batch candidates into groups for efficient API usage
    // Process up to 20 pairs per LLM call
    const batches = chunk(candidates, 20);

    for (const batch of batches) {
      // Check cache first
      const uncached: typeof batch = [];
      for (const c of batch) {
        const cacheKey = makeCacheKey(c.a.id, c.b.id);
        if (this.llmCache.has(cacheKey)) {
          if (this.llmCache.get(cacheKey)) {
            verified.push([c.a, c.b]);
          }
        } else {
          uncached.push(c);
        }
      }

      if (uncached.length === 0) continue;

      try {
        const results = await this.askClaude(uncached);
        for (let i = 0; i < uncached.length; i++) {
          const cacheKey = makeCacheKey(uncached[i].a.id, uncached[i].b.id);
          this.llmCache.set(cacheKey, results[i]);
          if (results[i]) {
            verified.push([uncached[i].a, uncached[i].b]);
          }
        }
      } catch (err) {
        logger.error({ error: String(err) }, "llm_verification_failed");
        // On failure, skip these candidates rather than false-positive
      }
    }

    return verified;
  }

  /**
   * Ask Claude whether market pairs are mutually exclusive.
   * Uses Haiku for cost efficiency (~$0.25/M input, $1.25/M output).
   */
  private async askClaude(
    pairs: { a: Market; b: Market; sim: number }[],
  ): Promise<boolean[]> {
    const pairDescriptions = pairs
      .map((p, i) => `${i + 1}. Market A: "${p.a.question}" | Market B: "${p.b.question}"`)
      .join("\n");

    const response = await this.anthropic!.messages.create({
      model: "claude-haiku-4-5-20251001",
      max_tokens: 1024,
      messages: [
        {
          role: "user",
          content: `You are analyzing prediction market questions for logical mutual exclusivity.

Two markets are MUTUALLY EXCLUSIVE if:
- They cannot BOTH be true at the same time
- If one happens, the other CANNOT happen
- They represent competing outcomes of the same underlying event

Examples of MUTUALLY EXCLUSIVE:
- "Will Trump win the 2024 election?" vs "Will Biden win the 2024 election?" (only one can win)
- "Will the Fed raise rates?" vs "Will the Fed cut rates?" (can't do both simultaneously)

Examples of NOT MUTUALLY EXCLUSIVE:
- "Will Bitcoin hit $100k?" vs "Will Ethereum hit $10k?" (both can happen)
- "Will it rain tomorrow?" vs "Will the S&P go up?" (unrelated events)
- "Will Trump win?" vs "Will there be a recession?" (both can be true)

For each pair below, respond with ONLY a JSON array of booleans (true = mutually exclusive, false = not).

${pairDescriptions}

Respond with ONLY a JSON array, e.g. [true, false, true]. No other text.`,
        },
      ],
    });

    const text =
      response.content[0].type === "text" ? response.content[0].text.trim() : "[]";

    try {
      const results = JSON.parse(text);
      if (Array.isArray(results) && results.length === pairs.length) {
        logger.debug(
          { pairs: pairs.length, exclusive: results.filter(Boolean).length },
          "llm_batch_result",
        );
        return results;
      }
    } catch {
      logger.warn({ raw: text }, "llm_parse_failed");
    }

    // If parsing fails, default to false (conservative)
    return pairs.map(() => false);
  }

  private async embedTexts(texts: string[]): Promise<Float32Array[]> {
    const embedder = await getEmbedder();
    const results: Float32Array[] = [];

    for (const text of texts) {
      if (this.embeddingCache.has(text)) {
        results.push(this.embeddingCache.get(text)!);
        continue;
      }

      const output = await embedder(text, { pooling: "mean", normalize: true });
      const embedding = new Float32Array(output.data);
      this.embeddingCache.set(text, embedding);
      results.push(embedding);
    }

    return results;
  }

  clearCache(): void {
    this.embeddingCache.clear();
    this.llmCache.clear();
  }
}

function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Already L2-normalized
}

function makeCacheKey(idA: string, idB: string): string {
  return idA < idB ? `${idA}|${idB}` : `${idB}|${idA}`;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    result.push(arr.slice(i, i + size));
  }
  return result;
}
