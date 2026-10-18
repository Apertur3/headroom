import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps the compiled pace core identical to its canonical source", () => {
  const normalize = (text: string): string => text.replace(/\r\n?/g, "\n");
  const source = readFileSync(new URL("../packages/policy/src/core.ts", import.meta.url), "utf8");
  const generated = readFileSync(new URL("../src/pace-core.ts", import.meta.url), "utf8");
  expect(normalize(generated)).toBe("// GENERATED from packages/policy/src/core.ts by scripts/sync-pace-core.mjs; do not edit\n" + normalize(source));
});
