import { describe, it, expect } from "vitest";
import { ArbitrageDetector } from "../src/engine/detector.js";
import type { Config } from "../src/config.js";
import type { Event, Market } from "../src/clients/types.js";

function makeConfig(overrides: Partial<Config["arbitrage"]> = {}): Config {
  return {
    scanIntervalSeconds: 10,
    dryRun: true,
    arbitrage: { min_edge_pct: 3.0, min_exit_edge_pct: 0.5, max_hold_hours: 48, ...overrides },
    risk: { max_position_usd: 100, max_concurrent_positions: 10, max_daily_loss_usd: 500, bankroll_fraction: 0.05 },
    fees: { maker_pct: 0, taker_pct: 0.0 },
    filters: { min_volume_usd: 0, min_liquidity_usd: 0 },
    execution: { makerTimeoutMs: 15000, makerSpreadOffset: 0.005, maxSlippage: 0.02 },
    credentials: { apiKey: "", secret: "", passphrase: "", privateKey: "" },
    mongodbUri: "",
    port: 3000,
  };
}

function makeMarket(id: string, question: string, yesPrice: number): Market {
  return {
    id,
    conditionId: "",
    question,
    outcomes: [
      { tokenId: `${id}-yes`, name: "Yes", price: yesPrice, side: "YES" },
      { tokenId: `${id}-no`, name: "No", price: 1 - yesPrice, side: "NO" },
    ],
    eventId: "event-1",
    volume: 100_000,
    liquidity: 50_000,
    active: true,
    closed: false,
  };
}

describe("ArbitrageDetector", () => {
  it("detects intra-event overround", () => {
    const detector = new ArbitrageDetector(makeConfig());
    const event: Event = {
      id: "e1",
      title: "Who wins?",
      slug: "who-wins",
      markets: [
        makeMarket("m1", "Will A win?", 0.55),
        makeMarket("m2", "Will B win?", 0.55),
      ],
      category: "politics",
      tags: [],
    };

    // Combined = 1.10, gross edge = 10%, fees = 0%, net = 10%
    const opps = detector.detectAll([event]);
    expect(opps).toHaveLength(1);
    expect(opps[0].netEdgePct).toBeCloseTo(10);
  });

  it("detects intra-event overround with high edge", () => {
    const detector = new ArbitrageDetector(makeConfig());
    const event: Event = {
      id: "e1",
      title: "Who wins?",
      slug: "who-wins",
      markets: [
        makeMarket("m1", "Will A win?", 0.60),
        makeMarket("m2", "Will B win?", 0.60),
      ],
      category: "politics",
      tags: [],
    };

    // Combined = 1.20, gross edge = 20%, fees = 0%, net = 20%
    const opps = detector.detectAll([event]);
    expect(opps).toHaveLength(1);
    expect(opps[0].arbType).toBe("intra_event");
    expect(opps[0].combinedProb).toBeCloseTo(1.2);
    expect(opps[0].netEdgePct).toBeCloseTo(20);
  });

  it("detects dutch book (underpriced)", () => {
    const detector = new ArbitrageDetector(makeConfig({ min_edge_pct: 1.0 }));
    const event: Event = {
      id: "e1",
      title: "Who wins?",
      slug: "who-wins",
      markets: [
        makeMarket("m1", "Will A win?", 0.40),
        makeMarket("m2", "Will B win?", 0.45),
      ],
      category: "",
      tags: [],
    };

    // Combined = 0.85, edge = 15%, fees = 0%, net = 15%
    const opps = detector.detectAll([event]);
    expect(opps).toHaveLength(1);
    expect(opps[0].combinedProb).toBeCloseTo(0.85);
  });

  it("detects cross-event arbitrage", () => {
    const detector = new ArbitrageDetector(makeConfig());
    const marketA = makeMarket("m1", "Will Trump win?", 0.60);
    const marketB = makeMarket("m2", "Will Democrats win?", 0.60);

    // Combined = 1.20, gross = 20%, fees = 0%, net = 20%
    const opps = detector.detectAll([], [[marketA, marketB]]);
    expect(opps).toHaveLength(1);
    expect(opps[0].arbType).toBe("cross_event");
    expect(opps[0].netEdgePct).toBeCloseTo(20);
  });

  it("ignores pairs with no edge", () => {
    const detector = new ArbitrageDetector(makeConfig());
    const marketA = makeMarket("m1", "Will A win?", 0.50);
    const marketB = makeMarket("m2", "Will B win?", 0.50);

    // Combined = 1.00, no overround, no dutch book
    const opps = detector.detectAll([], [[marketA, marketB]]);
    expect(opps).toHaveLength(0);
  });

  it("skips single-market events", () => {
    const detector = new ArbitrageDetector(makeConfig());
    const event: Event = {
      id: "e1",
      title: "Single",
      slug: "",
      markets: [makeMarket("m1", "Yes or no?", 0.80)],
      category: "",
      tags: [],
    };
    const opps = detector.detectAll([event]);
    expect(opps).toHaveLength(0);
  });
});
