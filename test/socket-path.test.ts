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

  // F16(b): the daemon derives its pipe name from a safeHeadroomDirectory()
  // home that has been through resolve()+realpath(), while a client normally
  // derives it from the raw, un-resolved HEADROOM_HOME. Before
  // canonicalizeHomeForPipe(), only the trailing-separator/case differences
  // above were normalized -- an interior "..", a mixed slash style, or a
  // relative segment still hashed to a different pipe, so the two sides
  // could end up dialing two different names for the very same directory.
  it("names the same pipe for interior dot components, mixed slash styles, and forward-slash spellings", () => {
    const canonical = socketPath("C:\\Users\\test\\.headroom", "win32", "test");
    expect(socketPath("C:\\Users\\test\\sub\\..\\.headroom", "win32", "test")).toBe(canonical);
    expect(socketPath("C:/Users/test/.headroom", "win32", "test")).toBe(canonical);
    expect(socketPath("C:\\Users\\test\\.\\.headroom", "win32", "test")).toBe(canonical);
  });
});
