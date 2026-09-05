import { describe, expect, it } from "vitest";
import { socketPath } from "../src/daemon.js";

describe("socketPath", () => {
  it("puts the POSIX socket inside the Headroom home", () => {
    expect(socketPath("/home/test/.headroom", "linux", "test")).toBe("/home/test/.headroom/headroom.sock");
  });

  it("gives two Windows homes of one user two different named pipes", () => {
    const first = socketPath("C:\\Users\\test\\.headroom", "win32", "test");
    const second = socketPath("C:\\Users\\test\\.headroom-2", "win32", "test");
    expect(first).toMatch(/^\\\\\.\\pipe\\headroom-test-[0-9a-f]{8}$/);
    expect(second).toMatch(/^\\\\\.\\pipe\\headroom-test-[0-9a-f]{8}$/);
    expect(first).not.toBe(second);
  });

  it("names the same pipe regardless of a trailing separator or letter case in the home path", () => {
    expect(socketPath("C:\\Users\\test\\.headroom\\", "win32", "test")).toBe(socketPath("c:\\users\\test\\.headroom", "win32", "test"));
  });
});
