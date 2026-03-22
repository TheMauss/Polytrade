/** Position sizing for arbitrage trades. */

/**
 * Calculate position size (USD) for an arbitrage opportunity.
 * Uses fraction-of-bankroll scaled by edge magnitude.
 */
export function calculatePositionSize(
  edgePct: number,
  bankroll: number,
  maxPosition = 100,
  fraction = 0.05,
): number {
  if (edgePct <= 0 || bankroll <= 0) return 0;

  const base = bankroll * fraction;

  // Scale by edge: 3% = 1x, 6% = 1.5x, 10% = 2x (capped)
  let edgeMultiplier = 1.0 + (edgePct - 3.0) / 6.0;
  edgeMultiplier = Math.min(Math.max(edgeMultiplier, 0.5), 2.0);

  return Math.min(base * edgeMultiplier, maxPosition);
}

/** Kelly criterion fraction. */
export function kellyFraction(edge: number, odds: number): number {
  if (odds <= 0) return 0;
  const p = 0.5 + edge / 2;
  const q = 1 - p;
  const b = odds - 1;
  if (b <= 0) return 0;
  const f = (b * p - q) / b;
  return Math.max(0, Math.min(f, 0.25));
}
