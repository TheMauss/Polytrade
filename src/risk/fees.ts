/** Fee calculator for Polymarket trades. */

/**
 * Calculate total fee percentage for an arbitrage trade.
 * @param numLegs Number of legs (markets) in the arbitrage.
 * @param feePct Fee percentage per trade (taker fee, e.g., 0.02 = 2%).
 * @param includeExit Whether to include exit fees.
 * @returns Total fee as a percentage (e.g., 8.0 for 8%).
 */
export function calculateTotalFees(
  numLegs: number,
  feePct = 0.02,
  includeExit = true,
): number {
  const multiplier = includeExit ? 2 : 1; // entry + exit
  return feePct * 100 * numLegs * multiplier;
}

/** Net cost per share including entry fee. */
export function netCostPerShare(price: number, feePct = 0.02): number {
  return price * (1 + feePct);
}

/** Net proceeds per share after exit fee. */
export function netProceedsPerShare(price: number, feePct = 0.02): number {
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
  feePct = 0.02,
): { totalCost: number; guaranteedPayout: number; profit: number; roiPct: number } {
  const totalImplied = prices.reduce((a, b) => a + b, 0);
  const numLegs = prices.length;

  let totalCost: number;
  let guaranteedPayout: number;

  if (totalImplied > 1.0) {
    // Overround: buy NO
    const noPrices = prices.map((p) => 1.0 - p);
    totalCost = noPrices
      .filter((p) => p > 0)
      .reduce((sum, np) => sum + netCostPerShare(np, feePct) * (investmentPerLeg / np), 0);
    const minNo = Math.min(...noPrices.filter((p) => p > 0));
    guaranteedPayout = (numLegs - 1) * (investmentPerLeg / minNo);
  } else {
    // Dutch book: buy YES
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
