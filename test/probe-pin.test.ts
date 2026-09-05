import { afterEach, describe, expect, it, vi, type Mock } from "vitest";

vi.mock("../src/adapters/claude.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/adapters/claude.js")>();
  return { ...actual, resolveProbePath: vi.fn() };
});

// eslint-disable-next-line import/order -- must follow the vi.mock call above
import { resolveProbePath } from "../src/adapters/claude.js";
import { probePinCheck } from "../src/doctor.js";
import type { HeadroomStore } from "../src/store.js";

afterEach(() => { vi.clearAllMocks(); });

function fakeStore(pinned: string | undefined): HeadroomStore {
  return { probePath: () => pinned } as unknown as HeadroomStore;
}

// probePinCheck is a no-op off macOS by design (the probe concept is
// macOS-only); every assertion below is about its darwin-only behavior.
describe.skipIf(process.platform !== "darwin")("probePinCheck: which probe binary is granted vs which would otherwise resolve", () => {
  it("reports INFO 'no probe granted yet' when nothing has ever been pinned", async () => {
    const result = await probePinCheck(fakeStore(undefined), ["claude-main"]);
    expect(result).toMatchObject({ level: "INFO", detail: expect.stringContaining("no probe granted yet") });
  });

  it("reports OK when the pinned binary still resolves and no other candidate exists", async () => {
    (resolveProbePath as Mock).mockImplementation(async (pin?: string) => pin ?? undefined);
    const result = await probePinCheck(fakeStore("/pinned/headroom-claude-probe"), ["claude-main"]);
    expect(result).toMatchObject({ level: "OK", detail: "granted: /pinned/headroom-claude-probe" });
  });

  it("reports INFO naming both binaries when a second, unused candidate also resolves -- never silently switching", async () => {
    (resolveProbePath as Mock).mockImplementation(async (pin?: string) => pin ?? "/other/headroom-claude-probe");
    const result = await probePinCheck(fakeStore("/pinned/headroom-claude-probe"), ["claude-main"]);
    expect(result?.level).toBe("INFO");
    expect(result?.detail).toContain("granted: /pinned/headroom-claude-probe");
    expect(result?.detail).toContain("not granted");
    expect(result?.detail).toContain("/other/headroom-claude-probe");
  });

  it("reports WARN with the fallback path when the granted binary is gone but something else still resolves", async () => {
    // Real fall-through behavior: resolveProbePath(pinnedPath) itself
    // returns whatever the normal order finds once the pin doesn't resolve
    // -- never undefined just because a pin was given and failed.
    (resolveProbePath as Mock).mockResolvedValue("/fallback/headroom-claude-probe");
    const result = await probePinCheck(fakeStore("/pinned/headroom-claude-probe"), ["claude-main"]);
    expect(result?.level).toBe("WARN");
    expect(result?.detail).toContain("granted binary is gone");
    expect(result?.detail).toContain("/fallback/headroom-claude-probe");
  });

  it("reports FAIL when the granted binary is gone and nothing else resolves either", async () => {
    (resolveProbePath as Mock).mockResolvedValue(undefined);
    const result = await probePinCheck(fakeStore("/pinned/headroom-claude-probe"), ["claude-main"]);
    expect(result?.level).toBe("FAIL");
  });

  it("reports nothing at all with no configured Claude principal", async () => {
    const result = await probePinCheck(fakeStore("/pinned/headroom-claude-probe"), []);
    expect(result).toBeUndefined();
  });
});

