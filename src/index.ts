/** Polytrade — main entry point. Starts engine + Express + Socket.IO. */

import express from "express";
import { createServer } from "http";
import { Server as SocketIOServer } from "socket.io";
import path from "path";
import { fileURLToPath } from "url";

import { loadConfig } from "./config.js";
import { GammaClient } from "./clients/gamma.js";
import { ClobClient } from "./clients/clob.js";
import type { Event } from "./clients/types.js";
import { MarketScanner } from "./engine/scanner.js";
import { ArbitrageDetector } from "./engine/detector.js";
import { CrossEventMatcher } from "./engine/matcher.js";
import { TradeExecutor } from "./engine/executor.js";
import { PositionMonitor } from "./engine/monitor.js";
import { RiskLimits } from "./risk/limits.js";
import { MongoStorage } from "./storage/mongo.js";
import { createRouter } from "./api/routes.js";
import { AlertManager } from "./utils/alerts.js";
import { logger } from "./utils/logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

async function main() {
  const config = loadConfig();
  const mode = config.dryRun ? "DRY RUN (paper trading)" : "LIVE TRADING";
  logger.info({ mode }, "polytrade_starting");

  // Clients
  const gamma = new GammaClient();
  const clob = new ClobClient(config.credentials);

  // MongoDB
  const storage = new MongoStorage(config.mongodbUri);
  try {
    await storage.connect();
    await storage.initIndexes();
  } catch (err) {
    logger.warn({ error: String(err) }, "mongodb_unavailable_running_without_persistence");
  }

  // Engine components
  const scanner = new MarketScanner(gamma, config);
  const detector = new ArbitrageDetector(config);
  const matcher = new CrossEventMatcher();
  const executor = new TradeExecutor(clob, config, storage);
  const monitor = new PositionMonitor(clob, executor, config, storage);
  const limits = new RiskLimits(config);
  const alerts = new AlertManager(process.env.WEBHOOK_URL);

  // Express + Socket.IO
  const app = express();
  const httpServer = createServer(app);
  const io = new SocketIOServer(httpServer);

  app.use(express.json());
  app.use(express.static(path.join(__dirname, "..", "public")));
  app.use(createRouter({ monitor, limits, config, storage }));

  // Socket.IO — broadcast updates
  io.on("connection", (socket) => {
    logger.info({ socketId: socket.id }, "dashboard_client_connected");
    socket.emit("update", buildDashboardPayload(monitor, limits));
  });

  // Periodic broadcast to all connected clients
  setInterval(() => {
    if (io.engine.clientsCount > 0) {
      io.emit("update", buildDashboardPayload(monitor, limits));
    }
  }, 3000);

  // Scan callback — the core arbitrage loop
  async function onScan(events: Event[]) {
    if (monitor.paused || limits.killed) return;

    // Find cross-event pairs
    let crossPairs: [import("./clients/types.js").Market, import("./clients/types.js").Market][] = [];
    try {
      crossPairs = await matcher.findExclusivePairs(events, 50);
    } catch (err) {
      logger.warn({ error: String(err) }, "matcher_failed_using_intra_only");
    }

    // Detect opportunities
    const opportunities = detector.detectAll(events, crossPairs);

    for (const opp of opportunities) {
      await storage.saveOpportunity(opp).catch(() => {});

      const { allowed, reason } = limits.canOpen(opp, monitor.positions, monitor.dailyPnl);
      if (!allowed) {
        logger.debug({ reason, edge: opp.netEdgePct }, "position_blocked");
        continue;
      }

      await alerts.alertOpportunity(opp);

      const position = await executor.openArbitrage(opp);
      if (position) {
        monitor.addPosition(position);
      }
    }
  }

  // Graceful shutdown
  const shutdown = () => {
    logger.info("shutdown_signal");
    scanner.stop();
    monitor.stop();
    httpServer.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  // Start everything
  httpServer.listen(config.port, () => {
    logger.info({ port: config.port, scanInterval: config.scanIntervalSeconds }, "polytrade_started");
  });

  // Run scanner and monitor concurrently
  Promise.all([
    scanner.run(onScan),
    monitor.run(5000),
  ]).catch((err) => {
    logger.error({ error: String(err) }, "engine_error");
  });
}

function buildDashboardPayload(monitor: PositionMonitor, limits: RiskLimits) {
  return {
    status: monitor.getStatus(),
    risk: limits.getStatus(),
    timestamp: new Date().toISOString(),
  };
}

main().catch((err) => {
  logger.fatal({ error: String(err) }, "fatal_startup_error");
  process.exit(1);
});
