/** Trade executor — opens and closes arbitrage positions. */

import { ClobClient } from "../clients/clob.js";
import type {
  ArbitrageOpportunity,
  ArbitragePosition,
  PositionLeg,
  Side,
  Market,
} from "../clients/types.js";
import type { Config } from "../config.js";
import type { MongoStorage } from "../storage/mongo.js";
import { calculatePositionSize } from "../risk/sizing.js";
import { logger } from "../utils/logger.js";
import { randomId } from "./utils.js";

export class TradeExecutor {
  private clob: ClobClient;
  private config: Config;
  private storage: MongoStorage | null;

  constructor(clob: ClobClient, config: Config, storage?: MongoStorage) {
    this.clob = clob;
    this.config = config;
    this.storage = storage ?? null;
  }

  /**
   * Open an arbitrage position.
   *
   * Overround (combined > 1.0): Buy NO on each market.
   * Dutch book (combined < 1.0): Buy YES on each market.
   */
  async openArbitrage(
    opp: ArbitrageOpportunity,
    bankroll = 10_000,
  ): Promise<ArbitragePosition | null> {
    const positionUsd = calculatePositionSize(
      opp.netEdgePct,
      bankroll,
      this.config.risk.max_position_usd,
      this.config.risk.bankroll_fraction,
    );

    const isOverround = opp.combinedProb > 1.0;
    const legs: PositionLeg[] = [];

    for (let i = 0; i < opp.markets.length; i++) {
      const market = opp.markets[i];
      const yesPrice = opp.prices[i];

      const side: Side = isOverround ? "NO" : "YES";
      const entryPrice = isOverround ? 1.0 - yesPrice : yesPrice;
      const legUsd = positionUsd / opp.markets.length;
      const shares = entryPrice > 0 ? legUsd / entryPrice : 0;

      const tokenId = getTokenId(market, side);
      if (!tokenId) {
        logger.warn({ marketId: market.id, side }, "no_token_id");
        continue;
      }

      if (!this.config.dryRun) {
        try {
          await this.clob.placeOrder(tokenId, "BUY", shares, entryPrice);
        } catch (err) {
          logger.error({ marketId: market.id, error: String(err) }, "order_failed");
          return null;
        }
      }

      legs.push({
        marketId: market.id,
        tokenId,
        side,
        entryPrice,
        size: legUsd,
        currentPrice: entryPrice,
      });
    }

    if (legs.length === 0) return null;

    const position: ArbitragePosition = {
      id: randomId(),
      arbType: opp.arbType,
      legs,
      openedAt: new Date(),
      entryEdgePct: opp.netEdgePct,
    };

    const mode = this.config.dryRun ? "PAPER" : "LIVE";
    const invested = legs.reduce((s, l) => s + l.size, 0);
    logger.info(
      { mode, positionId: position.id, arbType: position.arbType, legs: legs.length, invested, edgePct: opp.netEdgePct },
      "position_opened",
    );

    if (this.storage) {
      await this.storage.savePosition(position);
      await this.storage.saveTrade(position, "open");
    }

    return position;
  }

  async closePosition(
    position: ArbitragePosition,
    reason = "spread_normalized",
  ): Promise<number> {
    let totalPnl = 0;

    for (const leg of position.legs) {
      if (!this.config.dryRun) {
        try {
          const shares = leg.entryPrice > 0 ? leg.size / leg.entryPrice : 0;
          await this.clob.placeOrder(leg.tokenId, "SELL", shares, leg.currentPrice);
        } catch (err) {
          logger.error({ error: String(err), tokenId: leg.tokenId }, "close_order_failed");
        }
      }

      const diff =
        leg.side === "YES"
          ? leg.currentPrice - leg.entryPrice
          : leg.entryPrice - leg.currentPrice;
      totalPnl += leg.entryPrice > 0 ? diff * (leg.size / leg.entryPrice) : 0;
    }

    const mode = this.config.dryRun ? "PAPER" : "LIVE";
    const holdMs = Date.now() - position.openedAt.getTime();
    logger.info(
      { mode, positionId: position.id, reason, totalPnl: +totalPnl.toFixed(4), holdSeconds: holdMs / 1000 },
      "position_closed",
    );

    if (this.storage) {
      await this.storage.saveTrade(position, "close", totalPnl, reason);
      await this.storage.removePosition(position.id);
    }

    return totalPnl;
  }
}

function getTokenId(market: Market, side: Side): string | null {
  for (const o of market.outcomes) {
    if (o.side === side) return o.tokenId;
    if (side === "YES" && (o.name.toLowerCase() === "yes" || o.name.toLowerCase() === "true")) return o.tokenId;
    if (side === "NO" && (o.name.toLowerCase() === "no" || o.name.toLowerCase() === "false")) return o.tokenId;
  }
  // Fallback: first=YES, second=NO
  if (market.outcomes.length >= 2) {
    return market.outcomes[side === "YES" ? 0 : 1].tokenId;
  }
  return null;
}
