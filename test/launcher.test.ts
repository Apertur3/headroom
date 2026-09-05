import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { childEnvironment, policyProxyConfigured } from "../bin/headroom.js";

const temporary: string[] = [];
afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

const PROXY_KEYS = ["NODE_USE_ENV_PROXY", "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];

describe("launcher proxy stripping", () => {
  it("reads only the proxy key from policy.toml, ignoring everything else and a missing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-launcher-policy-")); temporary.push(root);
    expect(policyProxyConfigured(root)).toBe(false);
    await writeFile(join(root, "policy.toml"), "poll_interval_minutes = 5\n");
    expect(policyProxyConfigured(root)).toBe(false);
    await writeFile(join(root, "policy.toml"), 'poll_interval_minutes = 5\nproxy = "https://proxy.example:8080"\n');
    expect(policyProxyConfigured(root)).toBe(true);
    await writeFile(join(root, "policy.toml"), '# proxy = "https://commented-out.example"\n');
    expect(policyProxyConfigured(root)).toBe(false);
  });

  it("strips every proxy-related variable from the child environment by default", () => {
    const env = { PATH: "/usr/bin", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: "http://a", HTTPS_PROXY: "http://b", ALL_PROXY: "http://c", http_proxy: "http://d", https_proxy: "http://e", all_proxy: "http://f", UNRELATED: "keep-me" };
    const stripped = childEnvironment(env, false);
    for (const key of PROXY_KEYS) expect(stripped).not.toHaveProperty(key);
    expect(stripped.UNRELATED).toBe("keep-me");
    expect(stripped.PATH).toBe("/usr/bin");
    // The original object passed in is untouched.
    expect(env.HTTPS_PROXY).toBe("http://b");
  });

  it("leaves the environment untouched when policy.toml explicitly configures a proxy", () => {
    const env = { HTTPS_PROXY: "http://shell-proxy" };
    expect(childEnvironment(env, true)).toBe(env);
  });

  it("a child process spawned with childEnvironment()'s output sees no proxy variables, the same way the launcher spawns node", async () => {
    const root = await mkdtemp(join(tmpdir(), "headroom-launcher-spawn-")); temporary.push(root);
    const probe = join(root, "print-proxy-env.mjs");
    await writeFile(probe, `const keys = ${JSON.stringify(PROXY_KEYS)};\nconsole.log(JSON.stringify(keys.filter((key) => key in process.env)));\n`);
    const shellEnv = { ...process.env, PATH: process.env.PATH ?? "", HTTP_PROXY: "http://shell-proxy:3128", HTTPS_PROXY: "http://shell-proxy:3128", NODE_USE_ENV_PROXY: "1" };
    const result = spawnSync(process.execPath, [probe], { env: childEnvironment(shellEnv, policyProxyConfigured(root)), encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout.trim())).toEqual([]);
  });
});
