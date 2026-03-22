import { logger } from "./logger.js";
import type { ArbitrageOpportunity } from "../clients/types.js";

export class AlertManager {
  private webhookUrl: string | null;

  constructor(webhookUrl?: string) {
    this.webhookUrl = webhookUrl ?? null;
  }

  async alertOpportunity(opp: ArbitrageOpportunity): Promise<void> {
    const markets = opp.markets.map((m) => m.question.slice(0, 50)).join(", ");
    const msg = `[ARB ${opp.arbType}] Edge: ${opp.netEdgePct.toFixed(1)}% | Combined: ${opp.combinedProb.toFixed(3)} | ${markets}`;
    logger.info({ msg }, "alert_opportunity");

    if (this.webhookUrl) {
      await this.sendWebhook(msg);
    }
  }

  async alertTrade(action: string, positionId: string, pnl = 0): Promise<void> {
    const msg = `[TRADE ${action.toUpperCase()}] Position: ${positionId} | PnL: $${pnl.toFixed(2)}`;
    logger.info({ msg }, "alert_trade");

    if (this.webhookUrl) {
      await this.sendWebhook(msg);
    }
  }

  private async sendWebhook(message: string): Promise<void> {
    try {
      await fetch(this.webhookUrl!, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message }),
      });
    } catch (err) {
      logger.warn({ error: String(err) }, "webhook_failed");
    }
  }
}
