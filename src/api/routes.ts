/** Express REST API routes + Socket.IO for the dashboard. */

import { Router, type Request, type Response } from "express";
import type { MongoStorage } from "../storage/mongo.js";
import type { PositionMonitor } from "../engine/monitor.js";
import type { RiskLimits } from "../risk/limits.js";
import type { Config } from "../config.js";

export interface EngineState {
  monitor: PositionMonitor;
  limits: RiskLimits;
  config: Config;
  storage: MongoStorage;
}

export function createRouter(state: EngineState): Router {
  const router = Router();

  // Status
  router.get("/api/status", (_req: Request, res: Response) => {
    res.json(state.monitor.getStatus());
  });

  // Opportunities
  router.get("/api/opportunities", async (_req: Request, res: Response) => {
    const limit = parseInt((_req.query.limit as string) ?? "50", 10);
    res.json(await state.storage.getOpportunities(limit));
  });

  // Open positions
  router.get("/api/positions", async (_req: Request, res: Response) => {
    res.json(await state.storage.getOpenPositions());
  });

  // Trade history
  router.get("/api/trades", async (_req: Request, res: Response) => {
    const limit = parseInt((_req.query.limit as string) ?? "100", 10);
    const skip = parseInt((_req.query.skip as string) ?? "0", 10);
    res.json(await state.storage.getTradeHistory(limit, skip));
  });

  // Performance metrics
  router.get("/api/metrics", async (_req: Request, res: Response) => {
    res.json(await state.storage.getPerformanceMetrics());
  });

  // Risk status
  router.get("/api/risk", (_req: Request, res: Response) => {
    res.json(state.limits.getStatus());
  });

  // Controls
  router.post("/api/control/pause", (_req: Request, res: Response) => {
    state.monitor.paused = true;
    res.json({ status: "paused" });
  });

  router.post("/api/control/resume", (_req: Request, res: Response) => {
    state.monitor.paused = false;
    res.json({ status: "resumed" });
  });

  router.post("/api/control/kill", (_req: Request, res: Response) => {
    state.limits.activateKillSwitch();
    res.json({ status: "killed" });
  });

  router.post("/api/control/unkill", (_req: Request, res: Response) => {
    state.limits.deactivateKillSwitch();
    res.json({ status: "active" });
  });

  // Config update
  router.post("/api/config", (req: Request, res: Response) => {
    const updates = req.body;
    if (updates.min_edge_pct !== undefined) {
      state.config.arbitrage.min_edge_pct = Number(updates.min_edge_pct);
    }
    if (updates.max_position_usd !== undefined) {
      state.config.risk.max_position_usd = Number(updates.max_position_usd);
    }
    if (updates.dry_run !== undefined) {
      state.config.dryRun = Boolean(updates.dry_run);
    }
    res.json({ status: "updated", dryRun: state.config.dryRun });
  });

  return router;
}
