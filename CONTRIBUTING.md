# Contributing

Thanks for taking a look. Headroom is in beta and moves quickly; small, focused pull requests
land fastest.

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

```sh
npm install
npm run build
npm test
npm run engine:build   # optional, macOS or Linux with a Swift toolchain
```

Run `headroom` against your own accounts before opening a pull request and paste the redacted
output in the description.

## Reporting a security issue

See `SECURITY.md`. Please use a private advisory rather than a public issue.
