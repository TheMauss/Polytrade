/** Exposure limits and risk guardrails. */

import type { ArbitrageOpportunity, ArbitragePosition } from "../clients/types.js";
import type { Config } from "../config.js";
import { logger } from "../utils/logger.js";

export class RiskLimits {
  private config: Config;
  private _killed = false;

  constructor(config: Config) {
    this.config = config;
  }

  get killed(): boolean {
    return this._killed;
  }

  activateKillSwitch(): void {
    this._killed = true;
    logger.warn("kill_switch_activated");
  }

  deactivateKillSwitch(): void {
    this._killed = false;
    logger.info("kill_switch_deactivated");
  }

  canOpen(
    opp: ArbitrageOpportunity,
    openPositions: Map<string, ArbitragePosition>,
    dailyPnl: number,
  ): { allowed: boolean; reason: string } {
    if (this._killed) return { allowed: false, reason: "kill_switch_active" };

    if (openPositions.size >= this.config.risk.max_concurrent_positions) {
      return { allowed: false, reason: "max_positions_reached" };
    }

    if (dailyPnl < -this.config.risk.max_daily_loss_usd) {
      return { allowed: false, reason: "daily_loss_limit" };
    }

    // Don't double-expose on same markets
    const openMarketIds = new Set<string>();
    for (const pos of openPositions.values()) {
      for (const leg of pos.legs) openMarketIds.add(leg.marketId);
    }
    for (const market of opp.markets) {
      if (openMarketIds.has(market.id)) {
        return { allowed: false, reason: `already_exposed_to_${market.id}` };
      }
    }

    if (opp.netEdgePct < this.config.arbitrage.min_edge_pct) {
      return { allowed: false, reason: "edge_below_minimum" };
    }

    return { allowed: true, reason: "ok" };
  }

  getStatus(): Record<string, any> {
    return {
      killSwitch: this._killed,
      maxPositions: this.config.risk.max_concurrent_positions,
      maxDailyLoss: this.config.risk.max_daily_loss_usd,
      maxPositionUsd: this.config.risk.max_position_usd,
    };
  }
}
