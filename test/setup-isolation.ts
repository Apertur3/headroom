import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every test worker starts with HOME and HEADROOM_HOME pointing at fresh
// temporary directories, so no test can read or write the developer's real
// Headroom home, Claude profiles or credential files even when it forgets to
// scope them itself. A test that needs a specific home sets it explicitly.
const isolatedHome = mkdtempSync(join(tmpdir(), "headroom-test-home-"));
process.env.HOME = isolatedHome;
process.env.USERPROFILE = isolatedHome;
process.env.HEADROOM_HOME = join(isolatedHome, ".headroom");
delete process.env.CLAUDE_CONFIG_DIR;
