import { describe, expect, it } from "vitest";
import { nnls } from "../src/rate-nnls.js";

describe("nnls", () => {
  it("recovers an exact non-negative solution when one exists", () => {
    // A well-conditioned 3x2 system whose true solution is non-negative:
    // b = A * [2, 3].
    const a = [
      [1, 0],
      [0, 1],
      [1, 1],
    ];
    const b = [2, 3, 5];
    const { coefficients, residualSumSquares } = nnls(a, b);
    expect(coefficients[0]).toBeCloseTo(2, 6);
    expect(coefficients[1]).toBeCloseTo(3, 6);
    expect(residualSumSquares).toBeCloseTo(0, 6);
  });

  it("clamps a column that would need a negative coefficient to zero instead of returning one", () => {
    // Unconstrained least squares on this system wants a negative
    // coefficient for the second column; NNLS must return 0 there, never a
    // negative rate.
    const a = [
      [1, 1],
      [1, 2],
      [1, 3],
    ];
    const b = [1, 0.5, 0]; // decreasing in the second column -- true slope is negative
    const { coefficients } = nnls(a, b);
    expect(coefficients[1]).toBeGreaterThanOrEqual(0);
    for (const value of coefficients) expect(value).toBeGreaterThanOrEqual(0);
  });

  it("recovers a background/intercept-only fit when the class columns carry no signal", () => {
    // Every "class" column is zero; only the constant background column can
    // explain the (constant) target, matching how the rate learner's
    // background term absorbs unattributed movement.
    const a = [
      [0, 1],
      [0, 1],
      [0, 1],
      [0, 1],
    ];
    const b = [4, 4, 4, 4];
    const { coefficients, residualSumSquares } = nnls(a, b);
    expect(coefficients[0]).toBeCloseTo(0, 6);
    expect(coefficients[1]).toBeCloseTo(4, 6);
    expect(residualSumSquares).toBeCloseTo(0, 6);
  });

  it("returns an all-zero vector for a degenerate (empty) problem instead of throwing", () => {
    expect(nnls([], [])).toEqual({ coefficients: [], residualSumSquares: 0 });
  });

  it("every returned coefficient is non-negative on a larger, noisier synthetic problem", () => {
    // 40 rows, 5 columns (four "token classes" plus a background column),
    // built the same shape rate-learner.ts uses, with a small amount of
    // symmetric noise that could otherwise pull an ordinary least-squares
    // coefficient negative.
    const trueRates = [0.00002, 0.000005, 0.00001, 0.00008, 0.01];
    const a: number[][] = [];
    const b: number[] = [];
    let seed = 7;
    const nextNoise = () => { seed = (seed * 48271) % 2147483647; return ((seed / 2147483647) - 0.5) * 0.002; };
    for (let i = 0; i < 40; i++) {
      const row = [1000 * (i + 1), 500 * (i % 5), 200 * (i % 3), 800 * ((i * 7) % 11), 1];
      const exact = row.reduce((sum, value, j) => sum + value * trueRates[j], 0);
      a.push(row);
      b.push(Math.max(0, exact + nextNoise()));
    }
    const { coefficients } = nnls(a, b);
    expect(coefficients).toHaveLength(5);
    for (const value of coefficients) {
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
    }
  });
});
