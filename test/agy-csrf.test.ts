/** The keepalive starts agy with its own CSRF token, so the quota reader can find it on agy's command line. */
import { expect, it } from "vitest";
import { agyPtyCommand } from "../src/antigravity-keepalive.js";

it("passes --csrf_token to agy through the pid-file wrapper", () => {
  const [command, args] = agyPtyCommand("/opt/agy", "darwin", "/tmp/agy.pid", "token-1");
  expect(command).toBe("/usr/bin/script");
  expect(args).toEqual(["-q", "/dev/null", "/bin/sh", "-c", 'echo $$ > "$0" && exec "$@"', "/tmp/agy.pid", "/opt/agy", "--csrf_token=token-1"]);
  expect(agyPtyCommand("/opt/agy", "darwin")[1]).toEqual(["-q", "/dev/null", "/opt/agy"]);
});
