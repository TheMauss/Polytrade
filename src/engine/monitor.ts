/** Position monitor — tracks open positions and triggers exits. */

import { ClobClient } from "../clients/clob.js";
import type { ArbitragePosition } from "../clients/types.js";
import { positionPnl, currentEdgePct, positionInvested } from "../clients/types.js";
import type { Config } from "../config.js";
import type { MongoStorage } from "../storage/mongo.js";
import { TradeExecutor } from "./executor.js";
import { logger } from "../utils/logger.js";
import { sleep } from "./utils.js";

export class PositionMonitor {
  private clob: ClobClient;
  private executor: TradeExecutor;
  private config: Config;
  private storage: MongoStorage | null;

  public positions = new Map<string, ArbitragePosition>();
  private running = false;
  public dailyPnl = 0;
  private dailyResetDate = new Date().toISOString().slice(0, 10);
  public paused = false;

  constructor(
    clob: ClobClient,
    executor: TradeExecutor,
    config: Config,
    storage?: MongoStorage,
  ) {
    this.clob = clob;
    this.executor = executor;
    this.config = config;
    this.storage = storage ?? null;
  }

  addPosition(position: ArbitragePosition): void {
    this.positions.set(position.id, position);
  }

  private async updatePrices(position: ArbitragePosition): Promise<void> {
    for (const leg of position.legs) {
      try {
        const price = await this.clob.getPrice(leg.tokenId);
        if (price !== null) leg.currentPrice = price;
      } catch (err) {
        logger.warn({ tokenId: leg.tokenId, error: String(err) }, "price_update_failed");
      }
    }
  }

  private shouldClose(position: ArbitragePosition): string | null {
    const now = Date.now();
    const maxHoldMs = this.config.arbitrage.max_hold_hours * 3600 * 1000;

    if (now - position.openedAt.getTime() > maxHoldMs) return "max_hold_exceeded";

    const edge = Math.abs(currentEdgePct(position));
    if (edge < this.config.arbitrage.min_exit_edge_pct) return "spread_normalized";

    const pnl = positionPnl(position);
    if (pnl > 0 && edge < position.entryEdgePct * 0.5) return "profit_target";

    if (this.dailyPnl < -this.config.risk.max_daily_loss_usd) return "daily_loss_limit";

    return null;
  }

  async checkPositions(): Promise<void> {
    if (this.paused) return;

    const toClose: [string, string][] = [];

    for (const [id, position] of this.positions) {
      await this.updatePrices(position);
      const reason = this.shouldClose(position);
      if (reason) toClose.push([id, reason]);
    }

    for (const [id, reason] of toClose) {
      const position = this.positions.get(id)!;
      this.positions.delete(id);
      const pnl = await this.executor.closePosition(position, reason);
      this.dailyPnl += pnl;

      if (this.storage) {
        await this.storage.updateMetrics(pnl);
      }
    }
  }

  async run(checkInterval = 5000): Promise<void> {
    this.running = true;
    logger.info({ checkInterval }, "monitor_started");

    while (this.running) {
      // Reset daily PnL at midnight
      const today = new Date().toISOString().slice(0, 10);
      if (today !== this.dailyResetDate) {
        this.dailyPnl = 0;
        this.dailyResetDate = today;
      }

      await this.checkPositions();

      logger.debug(
        { openPositions: this.positions.size, dailyPnl: +this.dailyPnl.toFixed(2) },
        "monitor_tick",
      );

      await sleep(checkInterval);
    }
  }

  stop(): void {
    this.running = false;
  }

  getStatus(): Record<string, any> {
    const posArr = [...this.positions.values()];
    return {
      running: this.running,
      paused: this.paused,
      openPositions: this.positions.size,
      dailyPnl: +this.dailyPnl.toFixed(2),
      positions: posArr.map((p) => ({
        id: p.id,
        type: p.arbType,
        legs: p.legs.length,
        invested: +positionInvested(p).toFixed(2),
        pnl: +positionPnl(p).toFixed(4),
        entryEdge: +p.entryEdgePct.toFixed(2),
        currentEdge: +currentEdgePct(p).toFixed(2),
        ageMinutes: +((Date.now() - p.openedAt.getTime()) / 60_000).toFixed(1),
      })),
    };
  }
}
