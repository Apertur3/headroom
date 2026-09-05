import { lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { assertSafeAncestry } from "./paths.js";

/** Redact values that may identify an account or authorize a provider request. */
export function redact(value: string): string {
  return value
    // [^\n,;]+ (not [^\s,;]+): a header value can contain spaces ("Bearer
    // <opaque token>"); the prior pattern only ever consumed the scheme word
    // ("Bearer") up to that space, leaving the actual opaque token -- one
    // that doesn't happen to match sk-/eyJ/ya29./GOCSPX- below -- untouched.
    .replace(/Authorization\s*:\s*[^\n,;]+/gi, "[REDACTED]")
    .replace(/\b(?:Cookie|Set-Cookie)\s*:\s*[^\n]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\bya29\.[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\bGOCSPX-[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\b([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g, "[REDACTED]");
}

export function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

const PROXY_ENV_KEYS = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"];
const AMBIENT_PROXY_ENV_KEYS = ["NODE_USE_ENV_PROXY", ...PROXY_ENV_KEYS];

/** Child processes never inherit ambient proxy routing. */
export function outboundEnvironment(proxy?: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output = { ...env };
  for (const key of PROXY_ENV_KEYS) delete output[key];
  if (proxy) output.HTTPS_PROXY = proxy;
  return output;
}

/**
 * Call once at daemon and CLI process start, before any fetch happens. Recent
 * Node versions read HTTP_PROXY/HTTPS_PROXY/ALL_PROXY out of the environment
 * for the global fetch dispatcher when NODE_USE_ENV_PROXY is set; deleting all
 * four here means a proxy the operator's shell happened to have set cannot
 * silently route a credentialed vendor request through it unless Headroom's
 * own policy.toml opts in with an explicit `proxy` value.
 */
export function stripAmbientProxyEnvironment(proxy: string | undefined, env: NodeJS.ProcessEnv = process.env): void {
  if (proxy) return;
  for (const key of AMBIENT_PROXY_ENV_KEYS) delete env[key];
}

export function allowedOutbound(url: string, localBaseUrls: string[] = []): URL {
  const parsed = new URL(url);
  if (parsed.hostname === "api.anthropic.com" || parsed.hostname === "chatgpt.com" || parsed.hostname === "cloudcode-pa.googleapis.com" || parsed.hostname === "oauth2.googleapis.com") return parsed;
  if (localBaseUrls.some((base) => parsed.origin === new URL(base).origin)) return parsed;
  throw new Error("Outbound host is not allowed");
}

export interface OutboundFetchOptions {
  /** Additional origins allowed for this call only, e.g. a configured local pool base_url. */
  localBaseUrls?: string[];
}

/**
 * Every credentialed fetch in this repo goes through here instead of the bare
 * global fetch (or a test double standing in for it): it re-checks the
 * destination against the outbound allowlist before sending, refuses to
 * follow any redirect (`redirect: "manual"`, and any 3xx response is treated
 * as a failed fetch rather than resolved), and re-checks the allowlist
 * against the response's own final URL before handing the response back —
 * so a vendor endpoint cannot silently redirect a bearer token to a host
 * Headroom never approved.
 */
export async function outboundFetch(fetcher: typeof fetch, request: Request, options: OutboundFetchOptions = {}): Promise<Response> {
  const localBaseUrls = options.localBaseUrls ?? [];
  allowedOutbound(request.url, localBaseUrls);
  const response = await fetcher(request, { redirect: "manual" });
  if (response.status >= 300 && response.status < 400) throw new Error("redirect refused");
  if (response.url) allowedOutbound(response.url, localBaseUrls);
  return response;
}

/**
 * Shared filesystem-trust helpers. These mirror the checks store.ts's
 * safeHeadroomDirectory() and paths.ts's executablePath()/assertSafeAncestry()
 * already apply to the Headroom home and its executables, so any other spot
 * that reads from or writes to a directory outside Headroom's own database
 * (a configured statusline snapshot directory, the statusline output
 * directory) can reuse exactly the same trust boundary instead of a weaker
 * one-off check.
 */

/** Directory a Headroom command is about to write trusted output into:
 * created 0700 if absent, otherwise refused if it is a symlink, owned by
 * another user, or writable by group/other. Mirrors safeHeadroomDirectory's
 * own mkdir-then-lstat-verify order, under which a symlinked leaf is created
 * as a no-op by `mkdir(recursive)` (it already "exists") and only ever
 * caught by the lstat check that follows. Windows has no POSIX mode bits, so
 * only the symlink and (where meaningful) ownership checks apply there. */
export async function safeOutputDirectory(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe directory: ${dir}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Refusing directory owned by another user: ${dir}`);
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) throw new Error(`Refusing directory with group or world permissions: ${dir}`);
  return dir;
}

/** Read-only counterpart for a directory Headroom is about to scan for
 * external input it did not write itself (a configured statusline snapshot
 * directory): never created, and its ancestry (see assertSafeAncestry) must
 * be safe on top of the directory itself not being a symlink or
 * foreign-owned. Unlike safeOutputDirectory above (Headroom's own private
 * output, which it creates 0700 and expects to stay that way), an ordinary,
 * merely group/world-*readable* externally configured directory (0755, the
 * common default) is not itself a problem -- what assertSafeAncestry already
 * checks for the ancestor chain, and this repeats for the leaf: writable by
 * someone other than its owner, without the sticky bit that would stop them
 * from swapping its contents. A missing directory throws ENOENT, same as a
 * plain lstat, so a caller can tell "not configured" apart from "unsafe". */
export async function assertSafeReadableDirectory(dir: string): Promise<void> {
  await assertSafeAncestry(dirname(dir));
  const stat = await lstat(dir);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`Refusing unsafe directory: ${dir}`);
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) throw new Error(`Refusing directory owned by another user: ${dir}`);
  if (process.platform !== "win32") {
    const writableByOthers = (stat.mode & 0o022) !== 0;
    const sticky = (stat.mode & 0o1000) !== 0;
    if (writableByOthers && !sticky) throw new Error(`Refusing directory writable by group or other without the sticky bit: ${dir}`);
  }
}

/** Bytes trusted from one external snapshot file, matching the 64 KiB bound
 * quoted in the security review. */
export const SAFE_READ_MAX_BYTES = 64 * 1024;

/** Reads `path` only after an lstat proves it is a regular file, not a
 * symlink, FIFO, or device -- and refuses it outright if it is already
 * larger than `maxBytes`, before ever opening a descriptor. A second check on
 * the open descriptor's own fstat guards the (theoretical, single-user-scale)
 * race between that lstat and the open call. */
export async function readBoundedRegularFile(path: string, maxBytes: number = SAFE_READ_MAX_BYTES): Promise<string> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Refusing symlink or non-regular file: ${path}`);
  if (info.size > maxBytes) throw new Error(`Refusing oversized file (${info.size} > ${maxBytes} bytes): ${path}`);
  const handle = await open(path, "r");
  try {
    const opened = await handle.stat();
    if (opened.isSymbolicLink() || !opened.isFile() || opened.size > maxBytes) throw new Error(`Refusing unsafe file after open: ${path}`);
    const buffer = Buffer.alloc(maxBytes);
    const { bytesRead } = await handle.read(buffer, 0, maxBytes, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** True when `value`'s object/array nesting exceeds `maxDepth`. Walks with an
 * explicit stack rather than recursion, so a pathologically deep (but still
 * small, under the byte bound above) JSON document cannot exhaust the call
 * stack while it is being rejected. */
export function exceedsJsonDepth(value: unknown, maxDepth: number): boolean {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  while (stack.length) {
    const item = stack.pop()!;
    if (item.depth > maxDepth) return true;
    if (Array.isArray(item.value)) { for (const entry of item.value) stack.push({ value: entry, depth: item.depth + 1 }); }
    else if (item.value !== null && typeof item.value === "object") { for (const entry of Object.values(item.value as Record<string, unknown>)) stack.push({ value: entry, depth: item.depth + 1 }); }
  }
  return false;
}

/**
 * Writes `data` into `path` atomically and never through a link: a uniquely
 * named temporary file is created (exclusively, so it cannot itself already
 * be a link) in the same directory with the requested mode, then renamed
 * into place. `rename()` replaces whatever directory entry currently sits at
 * `path` -- including a symlink -- without ever dereferencing it, but an
 * existing symlink at `path` is refused outright rather than silently
 * replaced, since a link there is itself a sign the destination is not what
 * Headroom last wrote.
 */
export async function writeFileAtomic(path: string, data: string, mode: number): Promise<void> {
  try {
    const existing = await lstat(path);
    if (existing.isSymbolicLink()) throw new Error(`Refusing to write through symlinked destination: ${path}`);
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const directory = dirname(path);
  const temporaryPath = join(directory, `.${basename(path)}.${randomBytes(8).toString("hex")}.tmp`);
  const handle = await open(temporaryPath, "wx", mode);
  try { await handle.writeFile(data, "utf8"); }
  finally { await handle.close(); }
  try { await rename(temporaryPath, path); }
  catch (error) { await unlink(temporaryPath).catch(() => {}); throw error; }
}
