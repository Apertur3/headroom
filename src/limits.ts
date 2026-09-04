/** Limits for data received from credential-backed vendor endpoints. */
export const VENDOR_RESPONSE_MAX_BYTES = 1024 * 1024;
export const VENDOR_RESPONSE_MAX_DEPTH = 32;
export const VENDOR_RESPONSE_MAX_ARRAY_ITEMS = 10_000;
export const VENDOR_RESPONSE_MAX_STRING_BYTES = 64 * 1024;

export function assertVendorResponseLimits(value: unknown, depth = 0): void {
  if (depth > VENDOR_RESPONSE_MAX_DEPTH) throw new Error("vendor response exceeds JSON depth limit");
  if (typeof value === "string") {
    if (Buffer.byteLength(value, "utf8") > VENDOR_RESPONSE_MAX_STRING_BYTES) throw new Error("vendor response contains an oversized string");
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > VENDOR_RESPONSE_MAX_ARRAY_ITEMS) throw new Error("vendor response contains too many array items");
    for (const item of value) assertVendorResponseLimits(item, depth + 1);
    return;
  }
  if (value && typeof value === "object") for (const item of Object.values(value)) assertVendorResponseLimits(item, depth + 1);
}

export async function vendorJson(response: Response): Promise<unknown> {
  const text = await vendorText(response);
  const value: unknown = JSON.parse(text);
  assertVendorResponseLimits(value);
  return value;
}

/** Same 1 MiB cap as vendorJson, for a vendor response that is not JSON (e.g.
 * a Prometheus text exposition from a local pool's /metrics). */
export async function vendorText(response: Response): Promise<string> {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > VENDOR_RESPONSE_MAX_BYTES) throw new Error("vendor response exceeds 1 MiB limit");
  const text = await response.text();
  if (Buffer.byteLength(text, "utf8") > VENDOR_RESPONSE_MAX_BYTES) throw new Error("vendor response exceeds 1 MiB limit");
  return text;
}
