import { readFileSync, existsSync } from "fs";
import { parse } from "yaml";
import "dotenv/config";

export interface ArbitrageConfig {
  min_edge_pct: number;
  min_exit_edge_pct: number;
  max_hold_hours: number;
}

export interface RiskConfig {
  max_position_usd: number;
  max_concurrent_positions: number;
  max_daily_loss_usd: number;
  bankroll_fraction: number;
}

export interface FeeConfig {
  maker_pct: number;
  taker_pct: number;
}

export interface FilterConfig {
  min_volume_usd: number;
  min_liquidity_usd: number;
}

export interface Credentials {
  apiKey: string;
  secret: string;
  passphrase: string;
  privateKey: string;
}

export interface ExecutionConfig {
  makerTimeoutMs: number;   // How long to wait for maker fill before switching to taker
  makerSpreadOffset: number; // Place maker order this much below best ask (e.g., 0.005 = 0.5¢)
  maxSlippage: number;       // Max acceptable slippage for taker fallback
}

export interface Config {
  scanIntervalSeconds: number;
  dryRun: boolean;
  arbitrage: ArbitrageConfig;
  risk: RiskConfig;
  fees: FeeConfig;
  filters: FilterConfig;
  execution: ExecutionConfig;
  credentials: Credentials;
  mongodbUri: string;
  port: number;
}

export function loadConfig(configPath = "config.yaml"): Config {
  let data: Record<string, any> = {};

  if (existsSync(configPath)) {
    const raw = readFileSync(configPath, "utf-8");
    data = parse(raw) ?? {};
  }

  const env = process.env;

  // env override for dry_run
  const dryRunEnv = env.DRY_RUN;
  const dryRun =
    dryRunEnv !== undefined
      ? !["false", "0", "no"].includes(dryRunEnv.toLowerCase())
      : (data.dry_run ?? true);

  const arb = data.arbitrage ?? {};
  const risk = data.risk ?? {};
  const fees = data.fees ?? {};
  const filters = data.filters ?? {};
  const exec = data.execution ?? {};

  return {
    scanIntervalSeconds: data.scan_interval_seconds ?? 10,
    dryRun,
    arbitrage: {
      min_edge_pct: arb.min_edge_pct ?? 3.0,
      min_exit_edge_pct: arb.min_exit_edge_pct ?? 0.5,
      max_hold_hours: arb.max_hold_hours ?? 48,
    },
    risk: {
      max_position_usd: risk.max_position_usd ?? 100,
      max_concurrent_positions: risk.max_concurrent_positions ?? 10,
      max_daily_loss_usd: risk.max_daily_loss_usd ?? 500,
      bankroll_fraction: risk.bankroll_fraction ?? 0.05,
    },
    fees: {
      maker_pct: fees.maker_pct ?? 0.0,
      taker_pct: fees.taker_pct ?? 0.0,
    },
    filters: {
      min_volume_usd: filters.min_volume_usd ?? 50_000,
      min_liquidity_usd: filters.min_liquidity_usd ?? 10_000,
    },
    execution: {
      makerTimeoutMs: exec.maker_timeout_ms ?? 15_000,
      makerSpreadOffset: exec.maker_spread_offset ?? 0.005,
      maxSlippage: exec.max_slippage ?? 0.02,
    },
    credentials: {
      apiKey: env.POLY_API_KEY ?? "",
      secret: env.POLY_SECRET ?? "",
      passphrase: env.POLY_PASSPHRASE ?? "",
      privateKey: env.PRIVATE_KEY ?? "",
    },
    mongodbUri: env.MONGODB_URI ?? "mongodb://localhost:27017",
    port: parseInt(env.PORT ?? "3000", 10),
  };
}
