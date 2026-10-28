import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import ts from "typescript";

const caps = JSON.parse(readFileSync("size-ratchet.json", "utf8"));
const generated = new Set(["src/pace-core.ts", "src/browser-report-fonts.ts"]);
const files = [...new Set(execFileSync("git", ["ls-files", "-c", "-o", "-z", "--exclude-standard"], { encoding: "utf8" }).split("\0"))]
  .filter((file) => /\.(?:ts|mjs|js|sh)$/.test(file) && !generated.has(file));
let bad = false;
const fail = (message) => { console.error(message); bad = true; };

for (const [file, cap] of Object.entries(caps)) {
  if (!Number.isSafeInteger(cap) || cap <= 1000 || !files.includes(file)) fail(`Invalid ratchet: ${file}`);
}
for (const file of files) {
  const text = readFileSync(file, "utf8");
  const lines = (text.match(/\n/g) ?? []).length + Number(!!text && !text.endsWith("\n"));
  if (lines > 1000 && lines > (caps[file] ?? 1000)) fail(`${file}: ${lines} lines exceeds cap ${caps[file] ?? 1000}`);
  if (Object.hasOwn(caps, file) && (lines <= 1000 || caps[file] !== lines)) fail(`Refresh ratchet: ${file} (${lines} lines)`);
  if (lines > 400) console.warn(`${file}: ${lines} lines exceeds 400`);
  if (file.endsWith(".sh")) continue;
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const line = (pos) => source.getLineAndCharacterOfPosition(pos).line + 1;
  function visit(node) {
    if (ts.isFunctionLike(node) && node.body && line(node.end) - line(node.getStart(source)) + 1 > 100)
      console.warn(`${file}:${line(node.getStart(source))}: function exceeds 100 lines`);
    ts.forEachChild(node, visit);
  }
  visit(source);
}
process.exitCode = Number(bad);
