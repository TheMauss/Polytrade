/**
 * Trade executor — opens and closes arbitrage positions.
 *
 * Hybrid execution strategy:
 * 1. Place MAKER order (0% fee) slightly below best ask
 * 2. Wait up to makerTimeoutMs for fill
 * 3. If not filled, cancel and place TAKER order (2% fee) at market
 */

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
import { randomId, sleep } from "./utils.js";

interface FillResult {
  filled: boolean;
  fillPrice: number;
  feeType: "maker" | "taker";
}

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
   * Open an arbitrage position with hybrid maker→taker execution.
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
      const targetPrice = isOverround ? 1.0 - yesPrice : yesPrice;
      const legUsd = positionUsd / opp.markets.length;
      const shares = targetPrice > 0 ? legUsd / targetPrice : 0;

      const tokenId = getTokenId(market, side);
      if (!tokenId) {
        logger.warn({ marketId: market.id, side }, "no_token_id");
        continue;
      }

      if (!this.config.dryRun) {
        const fill = await this.hybridExecute(tokenId, "BUY", shares, targetPrice);
        if (!fill.filled) {
          logger.error({ marketId: market.id }, "hybrid_execution_failed");
          return null;
        }

        legs.push({
          marketId: market.id,
          tokenId,
          side,
          entryPrice: fill.fillPrice,
          size: legUsd,
          currentPrice: fill.fillPrice,
        });

        logger.info(
          { marketId: market.id, feeType: fill.feeType, fillPrice: fill.fillPrice },
          "leg_filled",
        );
      } else {
        // Dry run — simulate maker fill
        legs.push({
          marketId: market.id,
          tokenId,
          side,
          entryPrice: targetPrice,
          size: legUsd,
          currentPrice: targetPrice,
        });
      }
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

  /**
   * Hybrid execution: maker first, taker fallback.
   *
   * 1. Place limit order at (targetPrice - offset) → 0% maker fee
   * 2. Poll for fill up to makerTimeoutMs
   * 3. If not filled, cancel and place at best ask → 2% taker fee
   */
  private async hybridExecute(
    tokenId: string,
    orderSide: "BUY" | "SELL",
    shares: number,
    targetPrice: number,
  ): Promise<FillResult> {
    const { makerTimeoutMs, makerSpreadOffset, maxSlippage } = this.config.execution;

    // Step 1: Place maker order below best ask
    const makerPrice = orderSide === "BUY"
      ? targetPrice - makerSpreadOffset
      : targetPrice + makerSpreadOffset;

    try {
      const makerOrder = await this.clob.placeOrder(
        tokenId, orderSide, shares, +makerPrice.toFixed(4), "GTC",
      );
      const orderId = makerOrder?.orderID;

      logger.debug(
        { tokenId, makerPrice: +makerPrice.toFixed(4), orderId },
        "maker_order_placed",
      );

      // Step 2: Wait for fill
      const filled = await this.waitForFill(orderId, makerTimeoutMs);
      if (filled) {
        return { filled: true, fillPrice: makerPrice, feeType: "maker" };
      }

      // Step 3: Not filled — cancel maker and go taker
      logger.debug({ orderId }, "maker_timeout_switching_to_taker");
      await this.clob.cancelOrder(orderId).catch(() => {});

    } catch (err) {
      logger.warn({ error: String(err) }, "maker_order_failed_trying_taker");
    }

    // Taker fallback: place at target price (crosses the spread = immediate fill)
    try {
      const takerPrice = orderSide === "BUY"
        ? Math.min(targetPrice + maxSlippage, 0.99)
        : Math.max(targetPrice - maxSlippage, 0.01);

      await this.clob.placeOrder(
        tokenId, orderSide, shares, +takerPrice.toFixed(4), "FOK",
      );

      return { filled: true, fillPrice: targetPrice, feeType: "taker" };
    } catch (err) {
      logger.error({ error: String(err) }, "taker_order_also_failed");
      return { filled: false, fillPrice: 0, feeType: "taker" };
    }
  }

  /**
   * Poll for order fill status.
   * In production, this would check the CLOB API for order status.
   * For now, we use a simple polling approach.
   */
  private async waitForFill(orderId: string, timeoutMs: number): Promise<boolean> {
    const pollInterval = 2000;
    const maxAttempts = Math.ceil(timeoutMs / pollInterval);

    for (let i = 0; i < maxAttempts; i++) {
      await sleep(pollInterval);

      try {
        // Check if order is still in open orders
        const openOrders = await this.clob.getOpenOrders();
        const stillOpen = openOrders.some(
          (o: any) => o.orderID === orderId || o.id === orderId,
        );
        if (!stillOpen) {
          // Order is no longer open → either filled or cancelled
          return true; // Assume filled
        }
      } catch {
        // API error — continue polling
      }
    }

    return false; // Timeout
  }

  async closePosition(
    position: ArbitragePosition,
    reason = "spread_normalized",
  ): Promise<number> {
    let totalPnl = 0;

    for (const leg of position.legs) {
      if (!this.config.dryRun) {
        const shares = leg.entryPrice > 0 ? leg.size / leg.entryPrice : 0;
        const fill = await this.hybridExecute(
          leg.tokenId, "SELL", shares, leg.currentPrice,
        );
        if (!fill.filled) {
          logger.error({ tokenId: leg.tokenId }, "close_failed");
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
  if (market.outcomes.length >= 2) {
    return market.outcomes[side === "YES" ? 0 : 1].tokenId;
  }
  return null;
}
