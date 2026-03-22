import { describe, it, expect } from "vitest";
import { calculatePositionSize, kellyFraction } from "../src/risk/sizing.js";

describe("Position sizing", () => {
  it("returns 0 for zero/negative edge", () => {
    expect(calculatePositionSize(0, 10_000)).toBe(0);
    expect(calculatePositionSize(-1, 10_000)).toBe(0);
  });

  it("scales position with edge", () => {
    const small = calculatePositionSize(3.0, 10_000, 1000, 0.05);
    const large = calculatePositionSize(10.0, 10_000, 1000, 0.05);
    expect(large).toBeGreaterThan(small);
  });

  it("caps at max_position", () => {
    const pos = calculatePositionSize(20, 1_000_000, 100, 0.05);
    expect(pos).toBe(100);
  });

  it("respects bankroll fraction", () => {
    // 3% edge, $10k bankroll, 5% fraction = $500 base, 1.0x multiplier = $500
    const pos = calculatePositionSize(3.0, 10_000, 1000, 0.05);
    expect(pos).toBeCloseTo(500);
  });
});

describe("Kelly criterion", () => {
  it("returns 0 for zero odds", () => {
    expect(kellyFraction(0.05, 0)).toBe(0);
  });

  it("caps at 25%", () => {
    const f = kellyFraction(0.5, 10);
    expect(f).toBeLessThanOrEqual(0.25);
  });
});
