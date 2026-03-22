/** MongoDB storage for paper trading, trade history, and metrics. */

import { MongoClient, type Db, type Collection } from "mongodb";
import type { ArbitragePosition, ArbitrageOpportunity } from "../clients/types.js";
import { positionInvested } from "../clients/types.js";
import { logger } from "../utils/logger.js";

export class MongoStorage {
  private client: MongoClient;
  private db: Db;
  public trades: Collection;
  public positions: Collection;
  public opportunities: Collection;
  public metrics: Collection;

  constructor(connectionString = "mongodb://localhost:27017", dbName = "polytrade") {
    this.client = new MongoClient(connectionString);
    this.db = this.client.db(dbName);
    this.trades = this.db.collection("trades");
    this.positions = this.db.collection("positions");
    this.opportunities = this.db.collection("opportunities");
    this.metrics = this.db.collection("metrics");
  }

  async connect(): Promise<void> {
    await this.client.connect();
    logger.info("mongodb_connected");
  }

  async initIndexes(): Promise<void> {
    await this.trades.createIndex({ timestamp: -1 });
    await this.trades.createIndex({ position_id: 1 });
    await this.positions.createIndex({ id: 1 }, { unique: true });
    await this.opportunities.createIndex({ detected_at: -1 });
    await this.metrics.createIndex({ date: 1 }, { unique: true });
    logger.info("mongodb_indexes_created");
  }

  async saveOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    await this.opportunities.insertOne({
      id: opp.id,
      arbType: opp.arbType,
      markets: opp.markets.map((m) => m.question),
      marketIds: opp.markets.map((m) => m.id),
      prices: opp.prices,
      combinedProb: opp.combinedProb,
      grossEdgePct: opp.grossEdgePct,
      netEdgePct: opp.netEdgePct,
      detectedAt: opp.detectedAt,
    });
  }

  async savePosition(position: ArbitragePosition): Promise<void> {
    await this.positions.replaceOne(
      { id: position.id },
      {
        id: position.id,
        arbType: position.arbType,
        legs: position.legs.map((l) => ({
          marketId: l.marketId,
          tokenId: l.tokenId,
          side: l.side,
          entryPrice: l.entryPrice,
          size: l.size,
          currentPrice: l.currentPrice,
        })),
        openedAt: position.openedAt,
        entryEdgePct: position.entryEdgePct,
      },
      { upsert: true },
    );
  }

  async removePosition(positionId: string): Promise<void> {
    await this.positions.deleteOne({ id: positionId });
  }

  async saveTrade(
    position: ArbitragePosition,
    action: string,
    pnl = 0,
    reason = "",
  ): Promise<void> {
    await this.trades.insertOne({
      positionId: position.id,
      action,
      arbType: position.arbType,
      legs: position.legs.length,
      totalInvested: positionInvested(position),
      pnl,
      reason,
      timestamp: new Date(),
    });
  }

  async updateMetrics(pnl: number): Promise<void> {
    const today = new Date().toISOString().slice(0, 10);
    await this.metrics.updateOne(
      { date: today },
      {
        $inc: {
          totalPnl: pnl,
          tradeCount: 1,
          wins: pnl > 0 ? 1 : 0,
          losses: pnl < 0 ? 1 : 0,
        },
        $setOnInsert: { date: today },
      },
      { upsert: true },
    );
  }

  async getTradeHistory(limit = 100, skip = 0): Promise<any[]> {
    return this.trades
      .find({}, { projection: { _id: 0 } })
      .sort({ timestamp: -1 })
      .skip(skip)
      .limit(limit)
      .toArray();
  }

  async getOpenPositions(): Promise<any[]> {
    return this.positions.find({}, { projection: { _id: 0 } }).toArray();
  }

  async getOpportunities(limit = 50): Promise<any[]> {
    return this.opportunities
      .find({}, { projection: { _id: 0 } })
      .sort({ detectedAt: -1 })
      .limit(limit)
      .toArray();
  }

  async getPerformanceMetrics(): Promise<Record<string, any>> {
    const results = await this.trades
      .aggregate([
        { $match: { action: "close" } },
        {
          $group: {
            _id: null,
            totalPnl: { $sum: "$pnl" },
            totalTrades: { $sum: 1 },
            wins: { $sum: { $cond: [{ $gt: ["$pnl", 0] }, 1, 0] } },
            losses: { $sum: { $cond: [{ $lt: ["$pnl", 0] }, 1, 0] } },
            avgPnl: { $avg: "$pnl" },
            maxWin: { $max: "$pnl" },
            maxLoss: { $min: "$pnl" },
            totalInvested: { $sum: "$totalInvested" },
          },
        },
      ])
      .toArray();

    if (results.length === 0) {
      return { totalPnl: 0, totalTrades: 0, winRate: 0, avgPnl: 0, maxWin: 0, maxLoss: 0, roiPct: 0 };
    }

    const r = results[0];
    const totalTrades = r.totalTrades ?? 0;
    const wins = r.wins ?? 0;

    return {
      totalPnl: +(r.totalPnl ?? 0).toFixed(2),
      totalTrades,
      winRate: totalTrades > 0 ? +((wins / totalTrades) * 100).toFixed(1) : 0,
      avgPnl: +(r.avgPnl ?? 0).toFixed(4),
      maxWin: +(r.maxWin ?? 0).toFixed(4),
      maxLoss: +(r.maxLoss ?? 0).toFixed(4),
      roiPct: r.totalInvested > 0 ? +((r.totalPnl / r.totalInvested) * 100).toFixed(2) : 0,
    };
  }
}
