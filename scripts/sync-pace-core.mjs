import { readFile, writeFile } from "node:fs/promises";

const source = new URL("../packages/policy/src/core.ts", import.meta.url);
const target = new URL("../src/pace-core.ts", import.meta.url);
const normalize = (text) => text.replace(/\r\n?/g, "\n");
const expected = "// GENERATED from packages/policy/src/core.ts by scripts/sync-pace-core.mjs; do not edit\n" + normalize(await readFile(source, "utf8"));
if (process.argv.includes("--check")) {
  const actual = await readFile(target, "utf8").catch(() => "");
  if (normalize(actual) !== expected) {
    console.error("Pace core drift: run npm run sync:pace-core");
    process.exitCode = 1;
  }
} else {
  await writeFile(target, expected);
}
