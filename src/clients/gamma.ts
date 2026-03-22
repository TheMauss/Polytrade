/** Polymarket Gamma API client for market/event discovery. */

import { logger } from "../utils/logger.js";
import type { Event, Market, Outcome, Side } from "./types.js";

const GAMMA_BASE_URL = "https://gamma-api.polymarket.com";

export class GammaClient {
  private baseUrl: string;

  constructor(baseUrl = GAMMA_BASE_URL) {
    this.baseUrl = baseUrl;
  }

  async fetchActiveEvents(limit = 100, offset = 0): Promise<Event[]> {
    const url = new URL("/events", this.baseUrl);
    url.searchParams.set("limit", String(limit));
    url.searchParams.set("offset", String(offset));
    url.searchParams.set("active", "true");
    url.searchParams.set("closed", "false");

    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Gamma API ${resp.status}: ${resp.statusText}`);
    const data: any[] = await resp.json();

    const events: Event[] = [];
    for (const ev of data) {
      const markets: Market[] = [];
      for (const mkt of ev.markets ?? []) {
        const parsed = parseMarket(mkt);
        if (parsed) markets.push(parsed);
      }

      events.push({
        id: String(ev.id ?? ""),
        title: ev.title ?? "",
        slug: ev.slug ?? "",
        markets,
        category: ev.category ?? "",
        tags: ev.tags ?? [],
      });
    }

    logger.info({ count: events.length, offset }, "fetched_events");
    return events;
  }

  async fetchAllActiveEvents(maxPages = 20): Promise<Event[]> {
    const all: Event[] = [];
    const limit = 100;

    for (let page = 0; page < maxPages; page++) {
      const events = await this.fetchActiveEvents(limit, page * limit);
      if (events.length === 0) break;
      all.push(...events);
      if (events.length < limit) break;
    }

    logger.info({ total: all.length }, "fetched_all_events");
    return all;
  }
}

function parseMarket(mkt: any): Market | null {
  try {
    const outcomeNames = parseJsonField(mkt.outcomes) as string[];
    const outcomePrices = parseJsonField(mkt.outcomePrices) as string[];
    const tokenIds = parseJsonField(mkt.clobTokenIds) as string[];

    const outcomes: Outcome[] = [];
    for (let i = 0; i < outcomeNames.length; i++) {
      const name = String(outcomeNames[i]);
      const price = i < outcomePrices.length ? Number(outcomePrices[i]) : 0;
      const tokenId = i < tokenIds.length ? String(tokenIds[i]) : "";
      const side: Side = name.toLowerCase() === "yes" || name.toLowerCase() === "true" ? "YES" : "NO";

      outcomes.push({
        tokenId,
        name,
        price: Math.min(Math.max(price, 0), 1),
        side,
      });
    }

    return {
      id: String(mkt.id ?? ""),
      conditionId: String(mkt.conditionId ?? ""),
      question: mkt.question ?? "",
      outcomes,
      eventId: String(mkt.eventId ?? mkt.event_id ?? ""),
      volume: Number(mkt.volume ?? 0),
      liquidity: Number(mkt.liquidity ?? 0),
      active: mkt.active ?? true,
      closed: mkt.closed ?? false,
      endDate: mkt.endDate,
    };
  } catch (err) {
    logger.warn({ error: String(err), marketId: mkt.id }, "parse_market_failed");
    return null;
  }
}

function parseJsonField(val: unknown): unknown[] {
  if (Array.isArray(val)) return val;
  if (typeof val === "string") {
    try {
      return JSON.parse(val);
    } catch {
      return [];
    }
  }
  return [];
}
