/** Market scanner — periodically fetches and filters active markets. */

import { GammaClient } from "../clients/gamma.js";
import type { Event } from "../clients/types.js";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

export class MarketScanner {
  private gamma: GammaClient;
  private config: Config;
  public events: Event[] = [];
  private running = false;

  constructor(gamma: GammaClient, config: Config) {
    this.gamma = gamma;
    this.config = config;
  }

  async scanOnce(): Promise<Event[]> {
    try {
      const events = await this.gamma.fetchAllActiveEvents();

      // Filter by volume and liquidity thresholds
      const filtered: Event[] = [];
      for (const event of events) {
        const qualifying = event.markets.filter(
          (m) =>
            m.volume >= this.config.filters.min_volume_usd &&
            m.liquidity >= this.config.filters.min_liquidity_usd &&
            m.active &&
            !m.closed,
        );
        if (qualifying.length > 0) {
          filtered.push({ ...event, markets: qualifying });
        }
      }

      this.events = filtered;
      const totalMarkets = filtered.reduce((sum, e) => sum + e.markets.length, 0);
      logger.info(
        { totalEvents: events.length, filteredEvents: filtered.length, totalMarkets },
        "scan_complete",
      );
      return filtered;
    } catch (err) {
      logger.error({ error: String(err) }, "scan_failed");
      return this.events; // return last known good state
    }
  }

  async run(callback?: (events: Event[]) => Promise<void>): Promise<void> {
    this.running = true;
    logger.info({ interval: this.config.scanIntervalSeconds }, "scanner_started");

    while (this.running) {
      const events = await this.scanOnce();
      if (callback) await callback(events);
      await sleep(this.config.scanIntervalSeconds * 1000);
    }
  }

  stop(): void {
    this.running = false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
