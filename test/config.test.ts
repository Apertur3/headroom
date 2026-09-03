import { describe, expect, it } from "vitest";
import { defaultAntigravityKeepalive, parsePolicy } from "../src/policy.js";

describe("policy defaults", () => {
  it("keeps Antigravity alive when the key is absent on macOS and Linux", () => {
    const policy = parsePolicy("poll_interval_minutes = 5\n");
    expect(policy.antigravity_keepalive).toBe(defaultAntigravityKeepalive());
    expect(defaultAntigravityKeepalive("darwin")).toBe(true);
    expect(defaultAntigravityKeepalive("linux")).toBe(true);
    expect(defaultAntigravityKeepalive("win32")).toBe(false);
  });
});
