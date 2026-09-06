import { defineConfig } from "vitest/config";

// The suite opens hundreds of SQLite stores and shells out to scripts; the
// shared CI runners, Windows in particular, need more than the 5 s default
// before a slow test counts as a hang.
export default defineConfig({
  test: {
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
