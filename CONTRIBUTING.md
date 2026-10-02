# Contributing

Thanks for taking a look. Headroom moves quickly; small, focused pull requests
land fastest. Bug fixes bump the patch version, new features the minor version.

Headroom is a side project. Every issue and pull request gets read, and replies usually come
within a few days, but there is no guarantee, so a quiet week is not a no. Small, focused pull
requests against a `good first issue` are the easiest to review.

## Ground rules

- Never commit a credential, a fixture with a real token, or an email address. Fixtures are
  redacted before they enter the repo, and `npm test` includes a secret canary.
- Never commit a real email address (use `example.com`), a private/CGNAT IPv4 address (use an
  RFC 5737 documentation address like `192.0.2.x` instead), or a real username in a `/Users` or
  `/home` path (use `you`, `test`, `user`, or `example`). `npm run release:check` and CI run
  `scripts/privacy-sweep.sh` against every tracked file and the packed npm tarball to catch this;
  it also checks a small denylist of maintainer-specific machine and person names in
  `.privacy-denylist` (one regex per line, `(?i)` prefix for case-insensitive) -- extend that file
  rather than working around the check if a new name needs covering.
- Vendor adapters are pure functions from a principal to observations. Add a fixture directory
  with recorded, redacted responses for every new adapter, and a conformance test.
- A stale or failed reading is UNKNOWN. Do not add code that turns a missing value into
  capacity.
- Keep the Swift engine optional. Anything Claude or Codex needs belongs in TypeScript.

## Development

Node 22.13 or newer. The Swift engine is optional; everything Claude and Codex need is TypeScript.

```sh
npm install
npm run build          # tsc -> dist/
npm run lint           # type-check only (tsc --noEmit)
npm test               # the full suite (vitest)
npx vitest run test/pace.test.ts   # one file, while you iterate
bash scripts/privacy-sweep.sh      # the repo and packed-tarball canary CI also runs
npm run engine:build   # optional, macOS or Linux with a Swift toolchain
```

Run the full suite once before you push, not in a loop: it opens many SQLite stores and spawns
processes. The suite fails if a process it started is still alive afterwards, so a leaked child
shows up as a red run, not a silent one.

If you have accounts to try it on, run `headroom` before opening a pull request and paste the output
in the description, with account names, ids and emails redacted first. You do not need real accounts to work on most of the code: the tests
use fixtures and fake clocks.

When a change affects documented behavior, verify the built CLI help for the affected command,
keep the JSON contract and examples aligned, and check relative documentation links.

## Repo layout

| Path | What lives there |
|---|---|
| `src/` | The CLI, daemon, MCP server, store and policy. `src/adapters/` holds one pure adapter per vendor |
| `src/policy.ts`, `src/pace.ts` | Pace states and the `can`/`gate` decisions. The fail-closed rules live here |
| `src/canary.ts`, `src/agy-watchdog.ts`, `src/process-tree.ts` | The stale-lane canary and process hygiene |
| `engine/` | The optional Swift engine (macOS) |
| `test/` | One `*.test.ts` per area; `test/fixtures/` and `fixtures/` hold recorded or synthetic vendor payloads; `test/helpers/` holds shared fakes |
| `docs/` | User docs shipped in the package: quickstart, concepts, MCP, JSON contract, vendors |
| `skills/headroom/SKILL.md` | The agent skill. Keep it in step with the CLI and MCP tools |
| `examples/` | Starter `accounts.toml`, `policy.toml`, `routing.toml`, and the demo scripts `ci-gate.sh`, `mcp-quota-can.sh`, `orchestrator-loop.sh` (with the shared guard `lib.sh`) |
| `scripts/` | Build, release, privacy sweep, fixture recorder, demo screenshot |

## Pull requests

- One focused change per pull request, with a test that fails without it. A bug fix starts with
  the failing test.
- `npm run lint`, `npm test` and `bash scripts/privacy-sweep.sh` pass locally. CI repeats them on
  macOS, Ubuntu and Windows.
- A docs-only pull request (README, CHANGELOG, `docs/` and the other files `scripts/ci-scope.sh`
  allows) runs a fast subset: lint, the audits and the doc-reading tests. Any code change runs the full matrix.
- Use fake clocks and injected dependencies, not wall-clock sleeps. Timing races have been the
  main source of flaky tests here.
- Update the docs and `CHANGELOG.md` (under an `Unreleased` heading) when behavior changes. The
  maintainer sets version numbers.
- Plain commit messages that say what changed and why. No generated trailers.

## The redacted-fixture convention

Every real-world breakage gets a fixture, so it cannot come back unnoticed.

1. Capture the vendor payload that broke. For Antigravity, `scripts/record-antigravity-fixture.sh
   <label>` records the local reader's answer and keeps only allowlisted quota fields.
2. Redact before the file enters git: identity becomes `redacted`, emails become `user@example.com`,
   tokens and ids are dropped. Never commit a real token, account name or path.
3. Name it by date and shape, for example `2026-09-29-weekly-exhausted.json`. Use `.synthetic.` in
   the name when you wrote it by hand to reproduce a shape you saw.
4. Add a test that feeds the fixture through the code path that really receives it, and asserts the
   reading is UNKNOWN or blocked, never a made-up number.

## Demo data and generated images

Everything public-facing is generated from synthetic data by scripts in `scripts/`; nothing is
captured from a real account. Run `npm run build` first. The screenshot and social preview need a
local Chrome or Chromium (or set `CHROME`).

| Script | Produces |
|---|---|
| `scripts/render-dashboard-demo.mjs` | `docs/assets/dashboard.png` (pass `--html out.html` to keep the HTML) |
| `scripts/render-flow-demo.mjs` | `docs/assets/headroom-flow-demo.svg`, the real CLI output drawn as a terminal |
| `scripts/render-brand-assets.mjs` | the README hero banners and `docs/assets/social-preview.png` (1280x640) |
| `scripts/demo-home.mjs` | a seeded throwaway `HEADROOM_HOME` for the `examples/` scripts |

Use cached commands (`can`, `gate`, `dashboard`) against a demo home. `headroom status` polls, and
the demo accounts point at logins that do not exist.

## Reporting a problem

Run `headroom doctor --bundle` before opening an issue. It writes one redacted text file
(`headroom-bundle-<date>.txt` in the current directory by default, or a path you give it) and
prints where it landed and how big it is. The file holds your Headroom and Node versions, OS and
arch, the installed binary's path, the same diagnostics `headroom doctor` prints, your configured
principals (vendor and adapter only, never a path), your policy and routing config, the tail of
the daemon log, the last 20 audit rows, and the current status lines. Known token and credential
shapes, email addresses, private network addresses, this machine's hostname, home directory and
username are stripped before the file is written. Redaction is best effort, not a guarantee --
read the file yourself once before pasting it into the issue.

## Reporting a security issue

See `SECURITY.md`. Please use a private advisory rather than a public issue.
