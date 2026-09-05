import { describe, expect, it } from "vitest";
import { formatResetsIn, formatResetsInCoarse, resetsIn, withResetsIn } from "../src/resets.js";

describe("formatResetsIn", () => {
  it("renders minutes below an hour", () => {
    expect(formatResetsIn(12 * 60)).toBe("12m");
    expect(formatResetsIn(0)).toBe("0m");
    expect(formatResetsIn(59 * 60)).toBe("59m");
  });

  it("renders hours and minutes below two days", () => {
    expect(formatResetsIn(96 * 60)).toBe("1h 36m"); // 1h36m
    expect(formatResetsIn((26 * 60 + 18) * 60)).toBe("26h 18m");
    expect(formatResetsIn(60 * 60)).toBe("1h"); // exact hour, no trailing " 0m"
  });

  it("rolls over to days at 48 hours", () => {
    expect(formatResetsIn(47 * 3600)).toBe("47h");
    expect(formatResetsIn(50 * 3600)).toBe("2d 2h");
    expect(formatResetsIn(48 * 3600)).toBe("2d");
    expect(formatResetsIn(7 * 24 * 3600)).toBe("7d");
  });

  it("clamps a negative or already-passed duration to zero", () => {
    expect(formatResetsIn(-500)).toBe("0m");
  });
});

describe("formatResetsInCoarse", () => {
  it("keeps minutes below an hour", () => {
    expect(formatResetsInCoarse(12 * 60)).toBe("12m");
  });

  it("drops the subunit above an hour", () => {
    expect(formatResetsInCoarse((26 * 60 + 18) * 60)).toBe("26h");
    expect(formatResetsInCoarse(96 * 60)).toBe("1h");
  });

  it("rolls over to days at 48 hours", () => {
    expect(formatResetsInCoarse(50 * 3600)).toBe("2d");
  });
});

describe("resetsIn", () => {
  const now = new Date("2026-09-03T12:00:00Z");

  it("computes seconds and the formatted string from an ISO resets_at", () => {
    expect(resetsIn("2026-09-04T14:18:00Z", now)).toEqual({ resets_in_seconds: 94_680, resets_in: "26h 18m" });
  });

  it("returns null for both fields when resets_at is null, undefined, or unparsable", () => {
    expect(resetsIn(null, now)).toEqual({ resets_in_seconds: null, resets_in: null });
    expect(resetsIn(undefined, now)).toEqual({ resets_in_seconds: null, resets_in: null });
    expect(resetsIn("not a date", now)).toEqual({ resets_in_seconds: null, resets_in: null });
  });

  it("never returns a negative countdown for a reset already in the past", () => {
    expect(resetsIn("2026-09-03T11:00:00Z", now)).toEqual({ resets_in_seconds: 0, resets_in: "0m" });
  });
});

describe("withResetsIn", () => {
  it("attaches resets_in_seconds/resets_in to every item without mutating the input", () => {
    const now = new Date("2026-09-03T12:00:00Z");
    const items = [{ resets_at: "2026-09-03T12:12:00Z" }, { resets_at: null }];
    const result = withResetsIn(items, now);
    expect(result).toEqual([
      { resets_at: "2026-09-03T12:12:00Z", resets_in_seconds: 720, resets_in: "12m" },
      { resets_at: null, resets_in_seconds: null, resets_in: null },
    ]);
    expect(items[0]).not.toHaveProperty("resets_in_seconds"); // original left untouched
  });
});
