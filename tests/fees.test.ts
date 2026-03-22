import { describe, it, expect } from "vitest";
import { calculateTotalFees, netCostPerShare, netProceedsPerShare, calculateArbProfit } from "../src/risk/fees.js";

describe("Fee calculations", () => {
  it("calculates total fees for 2-leg trade", () => {
    // 2 legs, 2% fee, entry + exit
    const fees = calculateTotalFees(2, 0.02, true);
    expect(fees).toBeCloseTo(8.0); // 2 * 0.02 * 100 * 2 = 8%
  });

  it("calculates fees entry only", () => {
    const fees = calculateTotalFees(3, 0.02, false);
    expect(fees).toBeCloseTo(6.0); // 3 * 0.02 * 100 * 1 = 6%
  });

  it("calculates net cost per share", () => {
    expect(netCostPerShare(0.60, 0.02)).toBeCloseTo(0.612);
  });

  it("calculates net proceeds per share", () => {
    expect(netProceedsPerShare(0.60, 0.02)).toBeCloseTo(0.588);
  });
});

describe("Arb profit calculation", () => {
  it("calculates overround profit", () => {
    // Two markets at 60% each = 120% overround
    const result = calculateArbProfit([0.6, 0.6], 100, 0.02);
    expect(result.totalCost).toBeGreaterThan(0);
    expect(result.profit).toBeDefined();
  });

  it("calculates dutch book profit", () => {
    // Two markets at 40% each = 80% total
    const result = calculateArbProfit([0.4, 0.4], 100, 0.02);
    expect(result.totalCost).toBeGreaterThan(0);
  });
});
