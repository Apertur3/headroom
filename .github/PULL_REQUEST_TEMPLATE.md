## What and why

## How I checked it

- [ ] `npm run lint` and `npm test` pass locally
- [ ] `bash scripts/privacy-sweep.sh` passes
- [ ] New behavior has a test that fails without the change
- [ ] Docs, `skills/headroom/SKILL.md` and `CHANGELOG.md` updated where behavior changed
- [ ] Any new fixture is redacted (no real tokens, emails, hostnames, home paths)
- [ ] A missing or stale reading still ends as UNKNOWN, never as capacity
