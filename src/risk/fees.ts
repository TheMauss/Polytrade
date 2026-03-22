/**
 * Fee calculator for Polymarket trades.
 *
 * Fee structure (as of March 2026):
 * - Most prediction markets: 0% fees
 * - Crypto markets (15min, 5min, 1H, 4H, daily, weekly): up to 1.56% at 50% prob
 * - Sports (NCAAB, Serie A): up to 0.44% at 50% prob
 *
 * Fees are dynamic — always fetch fee_rate_bps from the CLOB API per token.
 */

/**
 * Calculate total fee percentage for an arbitrage trade.
 * @param numLegs Number of legs (markets) in the arbitrage.
 * @param feePct Fee percentage per trade (e.g., 0.0156 = 1.56%). Default 0 for most markets.
 * @param includeExit Whether to include exit fees.
 * @returns Total fee as a percentage (e.g., 6.24 for 6.24%).
 */
export function calculateTotalFees(
  numLegs: number,
  feePct = 0.0,
  includeExit = true,
): number {
  const multiplier = includeExit ? 2 : 1;
  return feePct * 100 * numLegs * multiplier;
}

/** Convert basis points to decimal fee rate. */
export function bpsToFeeRate(bps: number): number {
  return bps / 10_000;
}

/** Net cost per share including entry fee. */
export function netCostPerShare(price: number, feePct = 0.0): number {
  return price * (1 + feePct);
}

/** Net proceeds per share after exit fee. */
export function netProceedsPerShare(price: number, feePct = 0.0): number {
  return price * (1 - feePct);
}

/**
 * Calculate expected profit for an arbitrage opportunity.
 *
 * Overround (sum > 1): buy NO on all outcomes.
 * Dutch book (sum < 1): buy YES on all outcomes.
 */
export function calculateArbProfit(
  prices: number[],
  investmentPerLeg: number,
  feePct = 0.0,
): { totalCost: number; guaranteedPayout: number; profit: number; roiPct: number } {
  const totalImplied = prices.reduce((a, b) => a + b, 0);
  const numLegs = prices.length;

  let totalCost: number;
  let guaranteedPayout: number;

  if (totalImplied > 1.0) {
    const noPrices = prices.map((p) => 1.0 - p);
    totalCost = noPrices
      .filter((p) => p > 0)
      .reduce((sum, np) => sum + netCostPerShare(np, feePct) * (investmentPerLeg / np), 0);
    const minNo = Math.min(...noPrices.filter((p) => p > 0));
    guaranteedPayout = (numLegs - 1) * (investmentPerLeg / minNo);
  } else {
    totalCost = prices
      .filter((p) => p > 0)
      .reduce((sum, p) => sum + netCostPerShare(p, feePct) * (investmentPerLeg / p), 0);
    const maxPrice = Math.max(...prices);
    guaranteedPayout = maxPrice > 0 ? investmentPerLeg / maxPrice : 0;
  }

  const netPayout = guaranteedPayout * (1 - feePct);
  const profit = netPayout - totalCost;

  return {
    totalCost: +totalCost.toFixed(4),
    guaranteedPayout: +netPayout.toFixed(4),
    profit: +profit.toFixed(4),
    roiPct: totalCost > 0 ? +((profit / totalCost) * 100).toFixed(2) : 0,
  };
}
