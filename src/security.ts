/** Redact values that may identify an account or authorize a provider request. */
export function redact(value: string): string {
  return value
    .replace(/Authorization\s*:\s*[^\s,;]+/gi, "[REDACTED]")
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
