import { access, readFile, rm } from "node:fs/promises";
import { basename, join } from "node:path";
import { afterEach, vi } from "vitest";
import type { Observation } from "../../src/types.js";
import { alive } from "./mortal-process.js";

export async function withHeadroomHome<T>(home: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_HOME;
  process.env.HEADROOM_HOME = home;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_HOME; else process.env.HEADROOM_HOME = previous; }
}

export async function withEnv<T>(overrides: Record<string, string | undefined>, run: () => Promise<T>): Promise<T> {
  const previous = new Map(Object.keys(overrides).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(overrides)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  try { return await run(); }
  finally { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } }
}

export function captureLog(): { logs: string[]; restore: () => void } {
  const logs: string[] = [];
  const spy = vi.spyOn(console, "log").mockImplementation((line: string) => { logs.push(line); });
  return { logs, restore: () => spy.mockRestore() };
}

export function testSocketPath(root: string, label: string): string {
  return process.platform === "win32" ? `\\\\.\\pipe\\${basename(root)}-${label}` : join(root, `${label}.sock`);
}

export async function waitForFile(path: string, timeoutMs = 5_000): Promise<string> {
  const start = Date.now();
  for (;;) {
    try { const text = (await readFile(path, "utf8")).trim(); if (text) return text; } catch { /* not yet */ }
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${path}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export async function waitUntilDead(pid: number, timeoutMs = 4_000): Promise<void> {
  const start = Date.now();
  while (alive(pid)) {
    if (Date.now() - start > timeoutMs) throw new Error(`pid ${pid} still alive after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

export function captureOutput(): { stdout: string[]; stderr: string[]; restore: () => void } {
  const stdout: string[] = []; const stderr: string[] = [];
  const logSpy = vi.spyOn(console, "log").mockImplementation((line: string) => { stdout.push(String(line)); });
  const errorSpy = vi.spyOn(console, "error").mockImplementation((line: string) => { stderr.push(String(line)); });
  return { stdout, stderr, restore: () => { logSpy.mockRestore(); errorSpy.mockRestore(); } };
}

export function assistantLine(model: string, timestamp: string, inputTokens: number, outputTokens: number): string {
  return JSON.stringify({ type: "assistant", timestamp, message: { model, usage: { input_tokens: inputTokens, output_tokens: outputTokens } } });
}

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

export async function fileExists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

export async function withFakePlatform<T>(platform: NodeJS.Platform, run: () => T): Promise<T> {
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  Object.defineProperty(process, "platform", { value: platform, configurable: true });
  try { return await run(); }
  finally { Object.defineProperty(process, "platform", descriptor); }
}

export async function withProbePath<T>(path: string, run: () => Promise<T>): Promise<T> {
  const previous = process.env.HEADROOM_PROBE_PATH;
  process.env.HEADROOM_PROBE_PATH = path;
  try { return await run(); }
  finally { if (previous === undefined) delete process.env.HEADROOM_PROBE_PATH; else process.env.HEADROOM_PROBE_PATH = previous; }
}

/** Paths pushed here are removed after each test. */
export function useTemporary(): string[] {
  const temporary: string[] = [];
  afterEach(async () => { await Promise.all(temporary.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
  return temporary;
}

export const agyAccountsToml = (enabled: boolean, agyPath: string): string => [
  "[[accounts]]", 'name = "antigravity"', `enabled = ${enabled}`,
  'vendor = "antigravity"', 'location = "agy"', 'adapter = "native-ts"', `agy_path = "${agyPath}"`, "",
].join("\n");

export function fiveHour(used: number, fetchedAt: string, resetsAt: string, meterId = "claude-main:all"): Observation {
  return {
    principal_id: "claude-main", meter_id: meterId, window: { kind: "rolling", minutes: 300, enforcement: "hard" },
    quantity: { used, limit: 100, remaining: 100 - used, unit: "percent" }, resets_at: resetsAt,
    observed_at: fetchedAt, fetched_at: fetchedAt, source: "fixture", truth: "official", freshness: "fresh",
    confidence: 1, adapter_version: "fixture", upstream_schema_version: "fixture",
  };
}

export function weekly(used: number, fetchedAt: string, resetsAt: string, meterId = "claude-main:all"): Observation {
  return { ...fiveHour(used, fetchedAt, resetsAt, meterId), window: { kind: "fixed", minutes: 10_080, enforcement: "hard" } };
}
