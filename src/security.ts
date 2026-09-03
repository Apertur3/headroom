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
