/**
 * Non-negative least squares (Lawson & Hanson, 1974's active-set method), a
 * small dependency-free implementation sized for `rate-learner.ts`'s
 * low-dimensional problem: at most a handful of token-class columns plus one
 * background/intercept column, and up to a few thousand sample rows. No
 * matrix library: every helper here is plain arrays, which keeps this file
 * auditable and keeps the rest of Headroom (deliberately dependency-free at
 * runtime -- see package.json) that way too.
 *
 * Solves `minimize ||A x - b||^2 subject to x >= 0`, returning the
 * non-negative coefficient vector and its residual sum of squares. Every
 * caller in this codebase wants exactly this: a points-per-token rate can
 * never be negative (more tokens cannot free up meter headroom), so the
 * non-negativity constraint is not a numerical nicety here -- it is the
 * physical constraint the whole learner exists to respect.
 */

export interface NnlsResult {
  /** One non-negative coefficient per column of `A`, in column order. */
  coefficients: number[];
  residualSumSquares: number;
}

/** Below this, a candidate column's reduced gradient is treated as "does not
 * want to enter the passive set" and a passive coefficient is treated as
 * "at its zero bound" -- small enough to not reject a genuine, tiny positive
 * rate, large enough to keep floating-point noise from cycling the active
 * set forever. */
const TOLERANCE = 1e-10;

function matVec(a: readonly (readonly number[])[], x: readonly number[]): number[] {
  return a.map((row) => row.reduce((sum, value, j) => sum + value * x[j], 0));
}

function matTVec(a: readonly (readonly number[])[], residual: readonly number[], n: number): number[] {
  const result = new Array(n).fill(0);
  for (let i = 0; i < a.length; i++) {
    const row = a[i];
    const r = residual[i];
    for (let j = 0; j < n; j++) result[j] += row[j] * r;
  }
  return result;
}

function subtract(a: readonly number[], b: readonly number[]): number[] {
  return a.map((v, i) => v - b[i]);
}

function sumSquares(v: readonly number[]): number {
  return v.reduce((sum, value) => sum + value * value, 0);
}

/** Gaussian elimination with partial pivoting. `undefined` on a singular (or
 * near-singular, by the same tolerance the active-set loop uses) system --
 * callers treat that as "this candidate subproblem is unusable", never as a
 * huge or NaN coefficient. */
function solveLinearSystem(matrix: readonly (readonly number[])[], vector: readonly number[]): number[] | undefined {
  const n = vector.length;
  const m = matrix.map((row) => [...row]);
  const v = [...vector];
  for (let col = 0; col < n; col++) {
    let pivotRow = col;
    for (let row = col + 1; row < n; row++) if (Math.abs(m[row][col]) > Math.abs(m[pivotRow][col])) pivotRow = row;
    if (Math.abs(m[pivotRow][col]) < 1e-12) return undefined;
    if (pivotRow !== col) { [m[col], m[pivotRow]] = [m[pivotRow], m[col]]; [v[col], v[pivotRow]] = [v[pivotRow], v[col]]; }
    for (let row = col + 1; row < n; row++) {
      const factor = m[row][col] / m[col][col];
      if (factor === 0) continue;
      for (let k = col; k < n; k++) m[row][k] -= factor * m[col][k];
      v[row] -= factor * v[col];
    }
  }
  const x = new Array(n).fill(0);
  for (let row = n - 1; row >= 0; row--) {
    let sum = v[row];
    for (let col = row + 1; col < n; col++) sum -= m[row][col] * x[col];
    x[row] = sum / m[row][row];
  }
  return x;
}

/** Unconstrained least squares on the passive columns only, via the normal
 * equations `(A_P^T A_P) z = A_P^T b`. `cols` must be ascending and
 * duplicate-free; the caller (the active-set loop below) always passes it
 * that way. */
function solvePassiveLeastSquares(a: readonly (readonly number[])[], b: readonly number[], cols: readonly number[]): number[] | undefined {
  const p = cols.length;
  const ata: number[][] = Array.from({ length: p }, () => new Array(p).fill(0));
  const atb: number[] = new Array(p).fill(0);
  for (let row = 0; row < a.length; row++) {
    for (let i = 0; i < p; i++) {
      atb[i] += a[row][cols[i]] * b[row];
      for (let j = 0; j < p; j++) ata[i][j] += a[row][cols[i]] * a[row][cols[j]];
    }
  }
  return solveLinearSystem(ata, atb);
}

/**
 * `A` is `m` rows by `n` columns (row-major, `A[row][col]`); `b` is length
 * `m`. Every row of `A` must have the same length. Returns `n` non-negative
 * coefficients minimizing `||A x - b||^2`.
 *
 * Degenerate inputs (no rows, no columns) return an all-zero coefficient
 * vector rather than throwing -- the caller (rate-learner.ts) already
 * refuses to fit below its own minimum sample count, so this only ever sees
 * a well-formed, non-trivial problem in practice; the empty case is handled
 * here anyway so this file has no implicit dependency on that caller-side
 * guard to stay safe.
 */
export function nnls(a: readonly (readonly number[])[], b: readonly number[]): NnlsResult {
  const m = a.length;
  const n = m > 0 ? a[0].length : 0;
  if (b.length !== m) throw new Error("nnls: A and b row counts differ");
  for (const row of a) if (row.length !== n) throw new Error("nnls: every row of A must have the same length");
  const x = new Array(n).fill(0);
  if (n === 0 || m === 0) return { coefficients: x, residualSumSquares: sumSquares(b) };

  const passive = new Set<number>();
  // Bounds the outer (column-entering) loop at once per column plus a
  // margin for columns that re-enter after being dropped for infeasibility;
  // guards against floating-point cycling rather than reflecting a real
  // iteration count this problem size needs.
  const maxOuterIterations = 3 * n + 10;
  const maxInnerIterations = 3 * n + 10;

  for (let outer = 0; outer < maxOuterIterations; outer++) {
    const residual = subtract(b, matVec(a, x));
    const gradient = matTVec(a, residual, n);
    let bestIndex = -1;
    let bestValue = TOLERANCE;
    for (let j = 0; j < n; j++) {
      if (passive.has(j)) continue;
      if (gradient[j] > bestValue) { bestValue = gradient[j]; bestIndex = j; }
    }
    if (bestIndex === -1) break; // optimal: no active-set column still wants to increase

    passive.add(bestIndex);

    for (let inner = 0; inner < maxInnerIterations; inner++) {
      const cols = [...passive].sort((c1, c2) => c1 - c2);
      const z = solvePassiveLeastSquares(a, b, cols);
      if (!z) { passive.delete(bestIndex); break; } // singular subproblem: abandon this candidate for this outer pass

      const minZ = Math.min(...z);
      if (minZ > TOLERANCE) {
        for (let k = 0; k < cols.length; k++) x[cols[k]] = z[k];
        for (let j = 0; j < n; j++) if (!passive.has(j)) x[j] = 0;
        break;
      }

      // Infeasible: step from the current x toward z by the largest alpha
      // that keeps every passive coefficient non-negative, then drop
      // whichever hit zero and re-solve.
      let alpha = 1;
      for (let k = 0; k < cols.length; k++) {
        if (z[k] > TOLERANCE) continue;
        const denom = x[cols[k]] - z[k];
        if (denom > TOLERANCE) alpha = Math.min(alpha, x[cols[k]] / denom);
      }
      if (!Number.isFinite(alpha) || alpha < 0) alpha = 0;
      for (let k = 0; k < cols.length; k++) x[cols[k]] += alpha * (z[k] - x[cols[k]]);
      for (const j of [...passive]) if (x[j] <= TOLERANCE) { x[j] = 0; passive.delete(j); }
    }
  }

  const finalResidual = subtract(b, matVec(a, x));
  return { coefficients: x, residualSumSquares: sumSquares(finalResidual) };
}
