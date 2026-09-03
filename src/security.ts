/** Redact values that may identify an account or authorize a provider request. */
export function redact(value: string): string {
  return value
    .replace(/Authorization\s*:\s*[^\s,;]+/gi, "[REDACTED]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/=\-]+/gi, "[REDACTED]")
    .replace(/\bsk-[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\beyJ[A-Za-z0-9._~+\/=\-]+/g, "[REDACTED]")
    .replace(/\b([A-Za-z0-9._%+\-]+)@([A-Za-z0-9.\-]+\.[A-Za-z]{2,})\b/g, "[REDACTED]@$2");
}

export function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/** Child processes never inherit ambient proxy routing. */
export function outboundEnvironment(proxy?: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const output = { ...env };
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"]) delete output[key];
  if (proxy) output.HTTPS_PROXY = proxy;
  return output;
}

export function allowedOutbound(url: string, localBaseUrls: string[] = []): URL {
  const parsed = new URL(url);
  if (parsed.hostname === "api.anthropic.com" || parsed.hostname === "chatgpt.com") return parsed;
  if (localBaseUrls.some((base) => parsed.origin === new URL(base).origin)) return parsed;
  throw new Error("Outbound host is not allowed");
}
