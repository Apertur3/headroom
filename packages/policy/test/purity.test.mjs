import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
function files(directory) {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? files(path) : [path];
  });
}
function assertPure(source, path) {
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
  assert.doesNotMatch(code, /\b(?:process|require|globalThis)\b|\bfetch\s*\(|\bDate\s*\.\s*now\b|\bnew\s+Date\s*\(\s*\)|node:/, path);
  const imports = /\b(?:import|export)\s+(?:[^;]*?\s+from\s*)?["']([^"']+)["']|\b(?:import|require)\s*\(\s*["']([^"']+)["']/g;
  for (const match of code.matchAll(imports)) {
    const specifier = match[1] ?? match[2];
    assert.match(specifier, /^\.\.?\//, `${path}: ${specifier}`);
    const target = relative(root, resolve(dirname(path), specifier));
    assert.ok(target !== ".." && !target.startsWith(`..${sep}`), `${path}: escapes package`);
  }
  assert.doesNotMatch(code, /\bimport\s*\((?!\s*["'])/, `${path}: computed import`);
}

test("all package sources use only local imports and explicit time", () => {
  for (const path of files(resolve(root, "src"))) assertPure(readFileSync(path, "utf8"), path);
});

test("purity guard detects external dependencies, ambient effects and escaping imports", () => {
  const path = resolve(root, "src/example.ts");
  for (const source of [
    'import x from "external";', 'export { x } from "external";', 'import "external";',
    'import("external")', 'import(variable)', 'require("./local.js")',
    'import x from "../../../escape.js";', 'process.env', 'globalThis.x', 'fetch("url")',
    'Date.now()', 'new Date()', 'const x = "node:fs";',
  ]) assert.throws(() => assertPure(source, path), source);
  assertPure('import { x } from "./local.js"; export { x } from "../other.js"; new Date(0); import ( "./local.js" ); /* Date.now() */', path);
});
