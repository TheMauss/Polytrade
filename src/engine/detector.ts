/** Arbitrage detector — finds overround and dutch book opportunities. */

import type { ArbitrageOpportunity, Event, Market } from "../clients/types.js";
import type { Config } from "../config.js";
import { calculateTotalFees } from "../risk/fees.js";
import { logger } from "../utils/logger.js";
import { randomId } from "./utils.js";

export class ArbitrageDetector {
  private config: Config;

  constructor(config: Config) {
    this.config = config;
  }

  detectAll(
    events: Event[],
    crossEventPairs?: [Market, Market][],
  ): ArbitrageOpportunity[] {
    const opportunities: ArbitrageOpportunity[] = [];

    // 1. Intra-event: overround/dutch book within grouped markets
    for (const event of events) {
      opportunities.push(...this.detectIntraEvent(event));
    }

    // 2. Cross-event: mutually exclusive events priced separately
    if (crossEventPairs) {
      for (const [a, b] of crossEventPairs) {
        const opp = this.detectCrossEvent(a, b);
        if (opp) opportunities.push(opp);
      }
    }

    // Filter by minimum edge
    const profitable = opportunities.filter(
      (o) => o.netEdgePct >= this.config.arbitrage.min_edge_pct,
    );

    if (profitable.length > 0) {
      logger.info(
        {
          totalFound: opportunities.length,
          profitable: profitable.length,
          bestEdge: Math.max(...profitable.map((o) => o.netEdgePct)),
        },
        "arbitrage_detected",
      );
    }

    return profitable;
  }

  /**
   * Detect overround within a single event's grouped markets.
   *
   * For N mutually exclusive outcomes:
   * - Sum of YES prices > 1.0 → overround (buy NO on overpriced)
   * - Sum of YES prices < 1.0 → dutch book (buy YES on all)
   */
  private detectIntraEvent(event: Event): ArbitrageOpportunity[] {
    if (event.markets.length < 2) return [];

    const prices: number[] = [];
    const marketsWithPrices: Market[] = [];

    for (const market of event.markets) {
      const yesPrice = getYesPrice(market);
      if (yesPrice !== null) {
        prices.push(yesPrice);
        marketsWithPrices.push(market);
      }
    }

    if (prices.length < 2) return [];

    const combined = prices.reduce((a, b) => a + b, 0);
    const results: ArbitrageOpportunity[] = [];

    // Overround: collectively overpriced
    if (combined > 1.0) {
      const grossEdge = (combined - 1.0) * 100;
      const fees = calculateTotalFees(prices.length, this.config.fees.taker_pct);
      const netEdge = grossEdge - fees;

      if (netEdge > 0) {
        results.push({
          id: randomId(),
          arbType: "intra_event",
          markets: marketsWithPrices,
          prices,
          combinedProb: combined,
          grossEdgePct: grossEdge,
          netEdgePct: netEdge,
          detectedAt: new Date(),
        });
      }
    }

    // Dutch book: collectively underpriced
    if (combined < 1.0) {
      const grossEdge = (1.0 - combined) * 100;
      const fees = calculateTotalFees(prices.length, this.config.fees.taker_pct);
      const netEdge = grossEdge - fees;

      if (netEdge > 0) {
        results.push({
          id: randomId(),
          arbType: "intra_event",
          markets: marketsWithPrices,
          prices,
          combinedProb: combined,
          grossEdgePct: grossEdge,
          netEdgePct: netEdge,
          detectedAt: new Date(),
        });
      }
    }

    return results;
  }

  /**
   * Detect arbitrage between two mutually exclusive cross-event markets.
   * If combined YES > 1.0, there's overround to exploit.
   */
  private detectCrossEvent(
    marketA: Market,
    marketB: Market,
  ): ArbitrageOpportunity | null {
    const priceA = getYesPrice(marketA);
    const priceB = getYesPrice(marketB);
    if (priceA === null || priceB === null) return null;

    const combined = priceA + priceB;
    if (combined <= 1.0) return null;

    const grossEdge = (combined - 1.0) * 100;
    const fees = calculateTotalFees(2, this.config.fees.taker_pct);
    const netEdge = grossEdge - fees;
    if (netEdge <= 0) return null;

    return {
      id: randomId(),
      arbType: "cross_event",
      markets: [marketA, marketB],
      prices: [priceA, priceB],
      combinedProb: combined,
      grossEdgePct: grossEdge,
      netEdgePct: netEdge,
      detectedAt: new Date(),
    };
  }
}

/** Extract YES price from a market. */
function getYesPrice(market: Market): number | null {
  for (const o of market.outcomes) {
    if (o.name.toLowerCase() === "yes" || o.name.toLowerCase() === "true" || o.side === "YES") {
      return o.price;
    }
  }
  // Fallback: first outcome
  return market.outcomes.length > 0 ? market.outcomes[0].price : null;
}
