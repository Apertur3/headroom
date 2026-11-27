import { createServer, type RequestListener } from "node:http";
import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { adaptCodexPayload } from "../src/engine/codexbar/adapt.js";
import { inboxLines } from "../src/cli.js";
import { applyProxyPolicy, clean, outboundFetch, redact } from "../src/security.js";

describe("proxy policy", () => {
  it("always drops the shell's proxy variables and installs only the configured proxy, loopback direct", () => {
    const shell = () => ({ NODE_USE_ENV_PROXY: "1", HTTPS_PROXY: "http://shell-proxy.example:3128", all_proxy: "http://shell-proxy.example:1080", NO_PROXY: "pool.example", KEEP: "yes" });
    const installed: Record<string, string>[] = [];
    const env: NodeJS.ProcessEnv = shell();
    expect(applyProxyPolicy("http://proxy.example.com:8080/", env, (proxyEnv) => installed.push(proxyEnv))).toBe(true);
    expect(env).toEqual({ NO_PROXY: "pool.example", KEEP: "yes" });
    expect(installed).toEqual([{ HTTP_PROXY: "http://proxy.example.com:8080/", HTTPS_PROXY: "http://proxy.example.com:8080/", NO_PROXY: "pool.example,localhost,127.0.0.1,::1" }]);
    // No proxy configured: stripped the same way, and nothing is installed.
    const bare: NodeJS.ProcessEnv = shell();
    expect(applyProxyPolicy(undefined, bare, (proxyEnv) => installed.push(proxyEnv))).toBe(true);
    expect(bare).toEqual({ NO_PROXY: "pool.example", KEEP: "yes" });
    expect(installed).toHaveLength(1);
    // A Node without http.setGlobalProxyFromEnv says so instead of pretending.
    expect(applyProxyPolicy("http://proxy.example.com:8080/", shell(), null)).toBe(false);
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
