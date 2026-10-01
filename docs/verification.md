# What is measured, and how to reproduce it

Every number in the README comes from a command in this repository. This page says what each one
counts, how to get it yourself, and where it stops meaning anything.

## Reproduce it

```sh
npm ci
npm run lint        # type-check src/
npm test            # the full suite; prints "Tests  N passed"
bash scripts/privacy-sweep.sh   # tracked files and the packed npm tarball
```

Run the full suite once, on a machine that is not busy. It opens many SQLite stores and spawns
processes. The suite fails if a process it started is still alive when it ends
(`test/global-leak-gate.ts`).

## The numbers

| Claim | What it counts | Method | Limits |
|---|---|---|---|
| 1,898 tests (as of 2026-10-01; run `npm test` for the current figure) | Test cases in `test/*.test.ts`, run by vitest. Skips are platform-dependent: 1 on macOS, 31 on Ubuntu, 211 on Windows (skipped by the tests themselves) | `npm test`, last lines of output, per platform | A count of cases, not of behaviours covered. It does not measure line or branch coverage. Fewer tests run on Windows than on macOS |
| macOS, Ubuntu and Windows CI | One job per OS in `.github/workflows/ci.yml`: audit, lint, privacy sweep, tests, build, `npm pack --dry-run` | Open the Actions tab; the badge in the README is the latest `master` run | CI exercises the source tree. It is not an install from the npm registry on each OS |
| UNKNOWN, never a number | `can` and `gate` answer NO for a stale, failed, held or inconsistent reading | Tests in `test/store-policy.test.ts` and `test/antigravity-lane-classifier.test.ts` feed such readings and assert the decision | Proves the rule for the inputs the tests construct. A new vendor failure shape that nobody has recorded is not covered until a fixture exists |
| Fixtures per past breakage | Files in `test/fixtures/antigravity/` (6 today) and `fixtures/` | `ls test/fixtures/antigravity` | Six shapes seen so far, not every shape the vendor can produce |
| No private data in the repo or the package | A scan for emails, private addresses, home paths and a denylist | `bash scripts/privacy-sweep.sh` (also runs in CI) | A pattern scan. It cannot know a name it has not been told to look for |

## What the test run does not tell you

- **Timing.** Some tests depend on timers and process scheduling. On a heavily loaded machine a
  few can fail that pass on an idle one; CI is the reference run. Contributions that replace
  wall-clock waits with injected clocks are welcome.
- **Real vendors.** The suite never calls a real vendor. Vendor endpoints are private and can
  change; the fixtures show what they returned when recorded.
- **Platforms.** Windows is experimental: see "Honest numbers" in the [README](../README.md#honest-numbers)
  for what was and was not checked on a real machine.
