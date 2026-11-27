import { createServer, type RequestListener } from "node:http";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import ts from "typescript";
import { afterEach, describe, expect, it } from "vitest";
import { adaptCodexPayload } from "../src/engine/codexbar/adapt.js";
import { inboxLines } from "../src/cli.js";
import { applyProxyPolicy, clean, outboundFetch, redact } from "../src/security.js";

const execFileAsync = promisify(execFile);

describe("proxy policy", () => {
  const shell = (): NodeJS.ProcessEnv => ({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://shell-proxy.example:3128", all_proxy: "http://shell-proxy.example:1080", NO_PROXY: "upper.example", no_proxy: "lower.example", KEEP: "yes" });

  it("drops the shell's proxy variables, installs only the configured proxy, and reads no_proxy the way Node does", () => {
    const installed: Record<string, string>[] = [];
    const env = shell();
    expect(applyProxyPolicy("http://proxy.example.com:8080/", env, (proxyEnv) => installed.push(proxyEnv), [])).toBe(true);
    expect(env).toEqual({ NO_PROXY: "upper.example", no_proxy: "lower.example", KEEP: "yes" });
    // Lowercase no_proxy wins over NO_PROXY, as in Node's own proxy support.
    expect(installed).toEqual([{ HTTP_PROXY: "http://proxy.example.com:8080/", HTTPS_PROXY: "http://proxy.example.com:8080/", no_proxy: "lower.example,localhost,127.0.0.1,::1" }]);
    const { no_proxy: _lower, ...upperOnly } = shell();
    applyProxyPolicy("http://proxy.example.com:8080/", upperOnly, (proxyEnv) => installed.push(proxyEnv), []);
    expect(installed[1].no_proxy).toBe("upper.example,localhost,127.0.0.1,::1");
  });

  it("undoes a proxy Node installed at start when none is configured, and installs nothing when there was none", () => {
    const installed: Record<string, string>[] = [];
    expect(applyProxyPolicy(undefined, shell(), (proxyEnv) => installed.push(proxyEnv), [])).toBe(true);
    expect(installed).toEqual([{ HTTP_PROXY: "http://127.0.0.1:9", HTTPS_PROXY: "http://127.0.0.1:9", no_proxy: "*" }]);
    expect(applyProxyPolicy(undefined, { NODE_OPTIONS: "--use-env-proxy" }, (proxyEnv) => installed.push(proxyEnv), [])).toBe(true);
    expect(applyProxyPolicy(undefined, {}, (proxyEnv) => installed.push(proxyEnv), ["--use-env-proxy"])).toBe(true);
    expect(installed).toHaveLength(3);
    expect(applyProxyPolicy(undefined, { KEEP: "yes" }, (proxyEnv) => installed.push(proxyEnv), [])).toBe(true);
    expect(installed).toHaveLength(3);
    expect(applyProxyPolicy(undefined, {}, (proxyEnv) => installed.push(proxyEnv), ["--use_env_proxy"])).toBe(true);
    expect(applyProxyPolicy(undefined, { NODE_OPTIONS: "--use_env_proxy" }, (proxyEnv) => installed.push(proxyEnv), [])).toBe(true);
    expect(installed).toHaveLength(5);
    // A Node without http.setGlobalProxyFromEnv says so instead of pretending,
    // and stops outright when Node already set up a proxy it cannot undo.
    expect(applyProxyPolicy("http://proxy.example.com:8080/", {}, null, [])).toBe(false);
    expect(() => applyProxyPolicy(undefined, shell(), null, [])).toThrow(/Unset NODE_USE_ENV_PROXY and remove --use-env-proxy/);
    expect(() => applyProxyPolicy("http://proxy.example.com:8080/", {}, null, ["--use_env_proxy"])).toThrow(/cannot replace it/);
    expect(applyProxyPolicy(undefined, {}, null, [])).toBe(true);
  });

  it.skipIf(typeof (http as { setGlobalProxyFromEnv?: unknown }).setGlobalProxyFromEnv !== "function")("wins over a proxy Node set up at start from NODE_USE_ENV_PROXY=1", async () => {
    // A real child started the way a service might start dist/cli.js, with
    // the shell's proxy in its startup environment.
    const root = await mkdtemp(join(tmpdir(), "headroom-proxy-start-"));
    try {
      for (const name of ["security", "paths"]) {
        const source = await readFile(new URL(`../src/${name}.ts`, import.meta.url), "utf8");
        await writeFile(join(root, `${name}.js`), ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText);
      }
      await writeFile(join(root, "package.json"), JSON.stringify({ type: "module" }));
      await writeFile(join(root, "probe.js"), 'import { applyProxyPolicy } from "./security.js";\napplyProxyPolicy(process.argv[2] || undefined);\nconsole.log(await fetch("http://example.invalid/probe").then((r) => r.text(), (e) => `direct ${e.cause?.code ?? e.message}`));\n');
      const proxyServer = async (name: string) => { const server = createServer((_request, response) => response.end(name)); await new Promise<void>((done) => server.listen(0, "127.0.0.1", done)); return { server, url: `http://127.0.0.1:${(server.address() as { port: number }).port}` }; };
      const shellProxy = await proxyServer("shell-proxy"), configured = await proxyServer("configured-proxy");
      const run = async (...args: string[]) => (await execFileAsync(process.execPath, [join(root, "probe.js"), ...args], { env: { PATH: process.env.PATH ?? "", NODE_USE_ENV_PROXY: "1", HTTP_PROXY: shellProxy.url } })).stdout.trim();
      try {
        expect(await run()).toMatch(/^direct /);
        expect(await run(configured.url)).toBe("configured-proxy");
      } finally { shellProxy.server.close(); configured.server.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
});

describe("terminal-safe printing of text other processes wrote", () => {
  it("drops OSC 52, OSC 8, CSI and C1 sequences from an inbox line before it reaches the terminal", () => {
    const planted = "copy \x1b]52;c;c3ludGhldGlj\x07this \x1b]8;;https://example.com\x1b\\link\x1b]8;;\x1b\\ \x1b[2J\x9b31m\r\nend";
    expect(clean(planted)).toBe("copy this link   end");
    const [line] = inboxLines({ messages: [{ id: "m1", at: "2026-01-01T00:00:00Z", kind: "note", from: "agent\x1b]52;c;eA==\x07", body: planted }] as never, remaining: 0 });
    expect(line).not.toMatch(/[\x00-\x1f\x7f-\x9f]/);
    expect(line).toContain("from agent  copy this link");
  });
});

describe("secret-safe outputs", () => {
  it("redacts child-process diagnostics before they can become an output or log", () => {
    const output = redact("Authorization: Bearer sk-synthetic-value eyJ.synthetic.payload owner@example.com");
    for (const forbidden of ["Authorization", "Bearer", "sk-", "eyJ", "owner@example.com"]) expect(output).not.toContain(forbidden);
  });

  it("masks an email address whole, including its domain", () => {
    // The prior pattern kept the domain (`[REDACTED]@example.com`); the
    // domain alone can still identify an account.
    expect(redact("contact owner@example.com for help")).toBe("contact [REDACTED] for help");
    expect(redact("owner@example.com")).not.toContain("example.com");
  });

  it("redacts an opaque bearer token that matches no known key prefix, not just the scheme word", () => {
    // Regression: the Authorization pattern used to stop at the first space,
    // leaving "Bearer" redacted but the actual (opaque, non sk-/eyJ/ya29./
    // GOCSPX--shaped) token behind it untouched.
    const output = redact("Authorization: Bearer a1b2c3d4e5f6opaquetoken owner@example.com");
    expect(output).not.toContain("a1b2c3d4e5f6opaquetoken");
    expect(output).not.toContain("Bearer");
  });

  it("redacts Cookie and Set-Cookie header values", () => {
    expect(redact("Cookie: session=abc123; other=xyz")).not.toContain("abc123");
    expect(redact("Set-Cookie: session=abc123; Path=/; HttpOnly")).not.toContain("abc123");
  });

  it("redacts Google OAuth access and client-secret token prefixes", () => {
    const output = redact("access_token=ya29.synthetic-value client_secret=GOCSPX-synthetic-value");
    for (const forbidden of ["ya29.", "GOCSPX-"]) expect(output).not.toContain(forbidden);
    expect(output).toBe("access_token=[REDACTED] client_secret=[REDACTED]");
  });

  it("has no credential marker or fixture email in readings emitted from the recorded engine run", async () => {
    const fixture = await readFile(new URL("../fixtures/codexbar/v0.56.4/codex.json", import.meta.url), "utf8");
    const output = JSON.stringify(adaptCodexPayload(JSON.parse(fixture), "codex-main"));
    for (const forbidden of ["sk-", "eyJ", "Bearer", "user@example.com"]) expect(output).not.toContain(forbidden);
  });
});

describe("outboundFetch", () => {
  const servers: ReturnType<typeof createServer>[] = [];
  afterEach(async () => { await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => server.close(() => resolve())))); });

  async function stub(handler: RequestListener): Promise<string> {
    const server = createServer(handler);
    servers.push(server);
    try { await new Promise<void>((resolve, reject) => { server.once("error", reject).listen(0, "127.0.0.1", resolve); }); }
    catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") { server.close(); servers.splice(servers.indexOf(server), 1); throw error; }
      throw error;
    }
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("stub did not bind TCP");
    return `http://127.0.0.1:${address.port}`;
  }

  it("ignores HTTPS_PROXY set in the environment", async () => {
    let baseUrl: string;
    try { baseUrl = await stub((_request, response) => response.end("ok")); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP outboundFetch proxy stub: sandbox forbids listen(2)\n"); return; } throw error; }
    const previous = process.env.HTTPS_PROXY;
    process.env.HTTPS_PROXY = "http://127.0.0.1:1"; // nothing listens on this port
    try {
      const response = await outboundFetch(fetch, new Request(baseUrl), { localBaseUrls: [baseUrl] });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("ok");
    } finally {
      if (previous === undefined) delete process.env.HTTPS_PROXY; else process.env.HTTPS_PROXY = previous;
    }
  });

  it("refuses a redirect instead of following it", async () => {
    let baseUrl: string;
    try { baseUrl = await stub((_request, response) => { response.writeHead(302, { Location: "https://attacker.example/steal" }); response.end(); }); }
    catch (error: unknown) { if ((error as NodeJS.ErrnoException).code === "EPERM") { process.stderr.write("SKIP outboundFetch redirect stub: sandbox forbids listen(2)\n"); return; } throw error; }
    await expect(outboundFetch(fetch, new Request(baseUrl), { localBaseUrls: [baseUrl] })).rejects.toThrow("redirect refused");
  });
});
