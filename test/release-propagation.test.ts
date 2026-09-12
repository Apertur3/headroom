import { execFile } from "node:child_process";
import { mkdtemp, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, delimiter } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const script = join(__dirname, "..", "scripts", "wait-npm-release.sh");

it.each([
  ["delayed", 0, 14],
  ["missing", 1, 60],
  ["mismatch", 1, 1],
] as const)("registry %s: retries absence, fails closed on different bytes", async (mode, expectedCode, attempts) => {
  const home = await mkdtemp(join(tmpdir(), "headroom-registry-test-"));
  try {
    await writeFile(join(home, "npm"), `#!/usr/bin/env bash
count=0
[[ ! -f "$REGISTRY_COUNT" ]] || read -r count < "$REGISTRY_COUNT"
count=$((count + 1))
printf '%s\\n' "$count" > "$REGISTRY_COUNT"
if [[ "$REGISTRY_MODE" == mismatch ]]; then echo sha512-d3Jvbmc=; exit 0; fi
if [[ "$REGISTRY_MODE" == missing || "$count" -lt 14 ]]; then exit 1; fi
echo sha512-Zml4dHVyZQ==
`, { mode: 0o700 });
    let code = 0;
    try {
      await exec("bash", [script, "1.2.3", "sha512-Zml4dHVyZQ=="], {
        env: { ...process.env, PATH: `${home}${delimiter}${process.env.PATH}`, REGISTRY_COUNT: join(home, "count"), REGISTRY_MODE: mode, HEADROOM_REGISTRY_RETRY_SECONDS: "0" },
      });
    } catch (error) { code = (error as { code: number }).code; }
    expect(code).toBe(expectedCode);
    expect(Number(await readFile(join(home, "count"), "utf8"))).toBe(attempts);
  } finally { await rm(home, { recursive: true, force: true }); }
});
