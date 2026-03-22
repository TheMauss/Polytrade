#!/usr/bin/env npx tsx
/**
 * Live Polymarket arbitrage scanner.
 *
 * Run: npx tsx scripts/scan-live.ts
 *
 * Fetches all active events, checks for:
 * 1. Intra-event overround (sum of YES prices > 1)
 * 2. Intra-event dutch book (sum of YES prices < 1)
 * 3. Cross-event candidates via title similarity
 */

const GAMMA_API = "https://gamma-api.polymarket.com";

interface GammaMarket {
  id: string;
  question: string;
  outcomePrices: string;   // JSON string like "[\"0.55\",\"0.45\"]"
  outcomes: string;        // JSON string like "[\"Yes\",\"No\"]"
  volume: number;
  liquidity: number;
  active: boolean;
  closed: boolean;
  conditionId: string;
  clobTokenIds: string;    // JSON string
}

interface GammaEvent {
  id: string;
  title: string;
  slug: string;
  markets: GammaMarket[];
}

async function fetchAllEvents(): Promise<GammaEvent[]> {
  const allEvents: GammaEvent[] = [];
  let offset = 0;
  const limit = 100;

  while (true) {
    const url = `${GAMMA_API}/events?active=true&closed=false&limit=${limit}&offset=${offset}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`API ${resp.status}: ${resp.statusText}`);
    const events = (await resp.json()) as GammaEvent[];
    if (events.length === 0) break;
    allEvents.push(...events);
    offset += limit;
    if (events.length < limit) break;
  }

  return allEvents;
}

function parseOutcomePrices(market: GammaMarket): number[] {
  try {
    return JSON.parse(market.outcomePrices).map(Number);
  } catch {
    return [];
  }
}

interface ArbResult {
  type: "overround" | "dutch_book";
  eventTitle: string;
  eventId: string;
  markets: { question: string; yesPrice: number; volume: number }[];
  combinedProb: number;
  grossEdgePct: number;
}

function scanIntraEvent(events: GammaEvent[]): ArbResult[] {
  const results: ArbResult[] = [];

  for (const event of events) {
    if (event.markets.length < 2) continue;

    // Get YES prices for each market in the event
    const marketData: { question: string; yesPrice: number; volume: number }[] = [];

    for (const m of event.markets) {
      if (!m.active || m.closed) continue;
      const prices = parseOutcomePrices(m);
      if (prices.length < 1) continue;
      const yesPrice = prices[0];
      if (yesPrice <= 0 || yesPrice >= 1) continue;
      marketData.push({ question: m.question, yesPrice, volume: m.volume ?? 0 });
    }

    if (marketData.length < 2) continue;

    const combined = marketData.reduce((s, m) => s + m.yesPrice, 0);

    if (combined > 1.02) {
      // Overround
      const grossEdge = (combined - 1) * 100;
      results.push({
        type: "overround",
        eventTitle: event.title,
        eventId: event.id,
        markets: marketData,
        combinedProb: combined,
        grossEdgePct: grossEdge,
      });
    } else if (combined < 0.98 && marketData.length >= 2) {
      // Dutch book — only valid if markets are mutually exclusive & exhaustive
      const grossEdge = (1 - combined) * 100;
      results.push({
        type: "dutch_book",
        eventTitle: event.title,
        eventId: event.id,
        markets: marketData,
        combinedProb: combined,
        grossEdgePct: grossEdge,
      });
    }
  }

  return results;
}

async function main() {
  console.log("Fetching active events from Polymarket...\n");
  const events = await fetchAllEvents();
  console.log(`Found ${events.length} active events\n`);

  const multiMarketEvents = events.filter((e) => e.markets.length >= 2);
  console.log(`Events with 2+ markets: ${multiMarketEvents.length}\n`);

  console.log("=".repeat(80));
  console.log(" INTRA-EVENT ARBITRAGE SCAN");
  console.log("=".repeat(80));

  const arbs = scanIntraEvent(events);

  // Sort by edge
  arbs.sort((a, b) => b.grossEdgePct - a.grossEdgePct);

  if (arbs.length === 0) {
    console.log("\nNo intra-event arbitrage found.\n");
  } else {
    console.log(`\nFound ${arbs.length} opportunities:\n`);
    for (const arb of arbs.slice(0, 30)) {
      const emoji = arb.type === "overround" ? "OVERROUND" : "DUTCH_BOOK";
      console.log(`[${emoji}] ${arb.eventTitle}`);
      console.log(`  Combined: ${arb.combinedProb.toFixed(4)} | Gross edge: ${arb.grossEdgePct.toFixed(2)}%`);
      for (const m of arb.markets) {
        console.log(`    ${m.yesPrice.toFixed(3)} YES | vol $${(m.volume / 1000).toFixed(0)}k | ${m.question.slice(0, 70)}`);
      }
      console.log();
    }
  }

  // Stats
  console.log("=".repeat(80));
  console.log(" SUMMARY");
  console.log("=".repeat(80));
  const overrounds = arbs.filter((a) => a.type === "overround");
  const dutchBooks = arbs.filter((a) => a.type === "dutch_book");
  console.log(`\nOverrounds (>2% edge):  ${overrounds.length}`);
  console.log(`Dutch books (<-2% edge): ${dutchBooks.length}`);
  if (arbs.length > 0) {
    console.log(`Best edge: ${arbs[0].grossEdgePct.toFixed(2)}% (${arbs[0].type})`);
    console.log(`Avg edge:  ${(arbs.reduce((s, a) => s + a.grossEdgePct, 0) / arbs.length).toFixed(2)}%`);
  }

  // Show some stats about the data
  console.log(`\nTotal markets scanned: ${events.reduce((s, e) => s + e.markets.length, 0)}`);
  console.log(`Active multi-market events: ${multiMarketEvents.length}`);
}

main().catch(console.error);
