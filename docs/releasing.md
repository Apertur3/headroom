# Versioning and releases

Headroom uses semantic versioning. The version is the contract with people who script against
it, so the rules below decide the number, not the size of the diff.

## What counts as the public contract

- CLI commands, their flags and exit codes.
- The JSON shapes of `--json`, the daemon responses and the MCP tools, including field names,
  meter ids (`principal:meter`) and window kinds.
- Pace state names, event kinds and their meanings.
- The registry, policy and routing file formats.
- The store schema, in the sense that a newer version must read an older store.

Everything else (log wording, colors, the exact text of a reason) can change in any release.

## Which number moves

| Change | Bump | Examples |
|---|---|---|
| Bug fix, adapter fix, doc change, message wording, performance | patch, 0.1.x | a vendor field renamed upstream; a wrong reset time |
| Something new that keeps old calls working | minor, 0.x.0 | a new command, tool, event kind, adapter, JSON field, policy key |
| Anything that breaks an existing call or file | major | a removed or renamed command, flag, field, meter id or event; a store migration that cannot roll back |

Before 1.0 the same rules apply one level down: a breaking change bumps the minor version and is
called out in the changelog under "Breaking". 1.0.0 is cut when the contract above has gone one
month on all three platforms without a breaking change.

## Pre-releases

Public betas are `0.1.0-beta.N`. N goes up on every published change, however small. The
suffix is dropped for `0.1.0` once a beta has run a week without a blocking bug report.
Release candidates, if ever needed, use `-rc.N` the same way.

## The release itself

1. `CHANGELOG.md` gets a section for the version with the date, grouped as Added, Changed,
   Fixed, Removed, Security, and a Breaking list when one exists.
2. `package.json` and `package-lock.json` carry the same version; the release workflow refuses a
   tag that does not match.
3. The tag is `v<version>` on `master`, annotated, created by the maintainer and pushed after
   `npm run release:check` is green.
4. The release workflow verifies on ubuntu and macos (the CI workflow already covers windows on
   every push), builds the tarball on macos so it carries a real signed Claude probe, attaches it
   to a GitHub release with the changelog section as the body, and publishes to npm through
   trusted publishing: npmjs.com trusts this repository's `release.yml` workflow directly, no
   token exists anywhere, and every version carries provenance. If npm refuses the publish (the
   trusted publisher is not configured, or the version already exists) the job prints a warning
   instead of failing; re-run it after fixing the cause via `workflow_dispatch`, passing the
   existing release tag (`v<version>`, checked against that grammar before use). The workflow
   refuses to publish when the downloaded release asset's own `package.json` version does not
   match the dispatched tag. Every version, beta or not, is published under the `latest` dist-tag
   until a stable line exists.
5. A published version is never changed; a mistake gets the next number.

## The Homebrew tap

`brew install apertur3/tap/headroom` installs the published npm tarball through Homebrew and adds
a `brew services start headroom` service. The tap is the separate repository
[Apertur3/homebrew-tap](https://github.com/Apertur3/homebrew-tap), which holds one file that
matters, `Formula/headroom.rb`. After a tag push publishes to npm, the release workflow's
`homebrew` job downloads the tarball it just attached to the GitHub release, checks that the npm
registry carries those same bytes (npm's `dist.integrity` against a sha512 of the asset), hashes
it, runs `scripts/homebrew-formula.sh <version> <npm-tarball-url> <sha256>` and pushes the result
to the tap's default branch as a commit named `headroom <version>`, authored by `headroom-release`
at a GitHub noreply address. The job needs a repository secret `HOMEBREW_TAP_TOKEN`: a fine-grained
personal access token with contents write on `Apertur3/homebrew-tap` and nothing else. Without that
secret the job prints a notice and stops, so a missing or expired token never fails a release, it
only leaves the tap on the previous version; the same happens when the version is not on the npm
registry yet.

The tap has to be seeded by hand once, because a workflow cannot create the repository's first
commit for you. `docs/homebrew-tap-seed/` holds exactly what that first push contains, generated
by the same script and kept out of the npm package:

```sh
gh repo clone Apertur3/homebrew-tap /tmp/homebrew-tap
cp -R docs/homebrew-tap-seed/. /tmp/homebrew-tap/
git -C /tmp/homebrew-tap add README.md Formula/headroom.rb
git -C /tmp/homebrew-tap commit -m "headroom 0.1.0-beta.4"
git -C /tmp/homebrew-tap push
```

Create the token at https://github.com/settings/personal-access-tokens/new: resource owner
`Apertur3`, repository access "Only select repositories" with `Apertur3/homebrew-tap` alone,
repository permission Contents: Read and write, no account permissions, an expiry you will
remember. Then `gh secret set HOMEBREW_TAP_TOKEN --repo Apertur3/headroom` and paste it. When the
seed formula in this repository drifts from the version on npm, regenerate it with the script
rather than editing it: the tests compare the two.

## Deprecations

A command, flag or field that will be removed keeps working for at least one minor release,
prints a one-line notice on use, and is listed under Deprecated in the changelog before it is
removed in the next major (or, before 1.0, the next minor).
