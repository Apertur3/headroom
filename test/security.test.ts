import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { adaptCodexPayload } from "../src/engine/codexbar/adapt.js";
import { redact } from "../src/security.js";

describe("secret-safe outputs", () => {
  it("redacts child-process diagnostics before they can become an output or log", () => {
    const output = redact("Authorization: Bearer sk-synthetic-value eyJ.synthetic.payload owner@private.example");
    for (const forbidden of ["Authorization", "Bearer", "sk-", "eyJ", "owner@private.example"]) expect(output).not.toContain(forbidden);
  });

  it("has no credential marker or fixture email in readings emitted from the recorded engine run", async () => {
    const fixture = await readFile(new URL("../fixtures/codexbar/v0.56.4/codex.json", import.meta.url), "utf8");
    const output = JSON.stringify(adaptCodexPayload(JSON.parse(fixture), "codex-main"));
    for (const forbidden of ["sk-", "eyJ", "Bearer", "user@example.com"]) expect(output).not.toContain(forbidden);
  });
});
