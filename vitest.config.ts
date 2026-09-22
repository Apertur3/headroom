import { configDefaults, defineConfig } from "vitest/config";

// The suite opens hundreds of SQLite stores and shells out to scripts; the
// shared CI runners, Windows in particular, need more than the 5 s default
// before a slow test counts as a hang.
export default defineConfig({
  test: {
    setupFiles: ["./test/setup-isolation.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Agent worktrees (e.g. .claude/worktrees/<id>/) are full checkouts of
    // this repo nested inside it. Without an exclude here, running the
    // suite from the main checkout also picks up every test/*.test.ts file
    // inside each nested worktree, silently doubling (or worse) the test
    // count and runtime. Exclude .claude entirely -- worktrees are the only
    // thing Headroom puts there, but excluding the whole directory is
    // cheaper than trying to keep this list in sync with every worktree
    // that comes and goes -- alongside vitest's own defaults, which this
    // otherwise-empty `exclude` array would replace rather than extend.
    exclude: [...configDefaults.exclude, ".claude/**"],
  },
});
