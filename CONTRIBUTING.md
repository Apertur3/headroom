# Contributing

Thanks for taking a look. Headroom is pre-alpha and moves quickly; small, focused pull requests
land fastest.

## Ground rules

- Never commit a credential, a fixture with a real token, or an email address. Fixtures are
  redacted before they enter the repo, and `npm test` includes a secret canary.
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
