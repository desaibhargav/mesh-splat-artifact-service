import { describe, expect, it } from "vitest";
import { assertLodCount, lodTargets } from "../src/artifacts/lodPolicy.js";

describe("published LOD budgets", () => {
  it("budgets all levels against the source, rounding down", () => {
    expect(lodTargets(101)).toEqual([
      { level: 0, ratio: 0.3, count: 30 },
      { level: 1, ratio: 0.15, count: 15 },
      { level: 2, ratio: 0.075, count: 7 }
    ]);
  });
  it("refuses empty, fractional and unsafe source sizes", () => {
    for (const count of [0, 1, 3, -1, 5.5, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => lodTargets(count)).toThrow();
    }
  });
  it("does not allow a simplifier tolerance to exceed the published cap", () => {
    expect(() => assertLodCount(70, 70)).not.toThrow();
    for (const actual of [71, 0, NaN, 69.5]) {
      expect(() => assertLodCount(actual, 70)).toThrow("Output not published");
    }
  });
});
