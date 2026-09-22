# Usage-based prediction — ingestion foundation

This is still a **foundation**, not a prediction feature. There is no
predictor turning token counts into a percent-of-limit or a pace state, and
nothing here runs on its own — each `headroom usage import` invocation
explicitly selects the file to read. There is no
daemon integration, no MCP tool, no scheduler, and no directory walk or glob:
each invocation reads exactly one file the caller named.

## What exists today

- `src/usage-events.ts` — pure, filesystem-free normalization and dedup of
  the numeric usage counters on one Claude Code assistant transcript line
  (`input_tokens`, `output_tokens`, `cache_read_input_tokens`,
  `cache_creation_input_tokens`, and the `cache_creation` TTL breakdown).
  Rejects anything that isn't a finite, nonnegative, safe integer with a
  structured reason instead of guessing; folds revisions of the same
  assistant message (by an opaque local identity, never a raw vendor id)
  idempotently, quarantining conflicts rather than merging them.
- `src/usage-db.ts` / `src/usage-store.ts` — a private, opt-in `usage.db`
  SQLite file under `~/.headroom/`, entirely separate from `headroom.db` and
  its schema. `--source`/`--principal`/`--job` CLI aliases are never stored
  as free text, only as a per-database HMAC hash, so the database itself
  never carries the operator's chosen names.
- `src/usage-collector.ts` — reads one bounded batch of new bytes from one
  named file, owned/permission-checked before every read, and persists the
  result inside one transaction. A file identity check (device/inode, a
  fixed-size prefix hash, and a hash of the bytes just behind the last
  committed position) detects replacements, truncation and some edits behind the cursor.
  Replacement or truncation restarts the scan with identity deduplication;
  an unexplained boundary edit interrupts the import. The current batch is
  checked again before committing.
- `headroom usage import` / `headroom usage import-status` — the CLI surface
  over the above. See `headroom usage --help` for flags.

## How to use it

```
headroom usage import --source <origin-alias> --principal <account-alias> --path <jsonl-file> [--job <alias>] [--max-bytes N] [--json]
headroom usage import-status [--json]
```

- `--source` names where the file came from (e.g. a machine or agent alias),
  `--principal` names the account the usage belongs to. Both are hashed, not
  stored as text.
- One call reads at most `--max-bytes` new bytes (default 8 MiB) starting
  from where the last call for this exact `(source, canonicalized path)`
  pair left off, then returns. A file larger than that, or one still being
  appended to, needs the same command re-invoked to continue — nothing here
  schedules a follow-up run itself. A batch also stops after 10,000 line
  events to bound processing and memory; re-run to continue.
- Re-running the same `--source`/`--principal`/`--path` combination is safe:
  already-seen messages are deduplicated by identity, not re-counted.
- Copies and exports from the same origin must keep the same `--source`
  and `--principal` aliases to deduplicate across files. Different aliases
  describe independent origins and can count identical records separately.
- One canonicalized file path is bound to exactly one `(--source,
  --principal)` pair the first time it is imported. Re-running with a
  **different** `--source` or `--principal` against that same path is
  refused (`source_conflict` / `principal_conflict`), not silently accepted
  as a second independent origin: the fix is to pass the same `--source`/
  `--principal` the file was first imported under, never to switch to a new
  alias to force the run through — that would double-count the same lines
  under two separate bindings.
- `--job` is optional, best-effort linkage evidence (e.g. "this file belongs
  to job X"), not a verified claim of exclusive ownership over every line in
  the file: a `--job` that conflicts with one already bound to a cursor is
  withheld as ambiguous — never overwritten, never treated as a trusted
  link, never used to reject the numeric import itself. Identities already
  claimed by a different job lose that job association rather than being
  merged under two claims.
- An import can be interrupted (refused to commit further) for more than one
  reason: content changed just behind the cursor, the file changed while
  this run was still reading it, or a concurrent `headroom usage import` run
  committed first. The import result reports the reason (including in
  `--json`). Interrupted runs leave persisted state unchanged, so
  `import-status` describes the last committed scan, not the latest refused attempt.

Imported numeric records are retained locally; automatic pruning is not yet
implemented.

## What this is not

- No automatic background collection: nothing here watches
  `~/.claude*/projects/**/*.jsonl`, walks a directory, or schedules itself.
  Every run is one explicit, file-scoped invocation; a background/opt-in mode
  is future work, not shipped.
- Not a predictor: no token-to-percent conversion, no pace state, no
  relationship to a vendor's actual quota.
- Not settled billing evidence: "a message is visible in a transcript" is
  the only finalization evidence this ingests. It is not proof the vendor's
  own billing/accounting has settled the call, and it is not a forecast or
  admission promise of any kind.
- Not a coverage guarantee: totals in `import-status` cover only the files an
  operator has explicitly imported, from whichever `--source`/`--principal`
  pairs were passed. There is no claim about having seen a whole account's
  usage, a whole session, or every message in a file — an append-oriented
  cursor can miss an edit made to already-committed, earlier bytes (it can
  only detect — not always catch — a change immediately behind its own
  cursor). `import-status`'s grouped totals mark a field `unknown` when no
  imported identity carried a value for it, and separately report a missing
  count alongside any partial sum, rather than treating either as zero.

## Coverage and evidence markers

Every `headroom usage import` and `headroom usage import-status` output
(human and `--json`, including the empty/no-data case) carries three fixed
markers rather than leaving coverage implicit:

| Marker | Fixed value | Meaning |
|---|---|---|
| `coverage` | `imported_files_only` | Counts only files an operator explicitly imported, never a whole account or session. |
| `account_coverage` | `unknown` | No claim is made about what fraction of an account's real usage that represents. |
| `evidence` | `message_visible` | The only finalization evidence this ingests: a message was visible in a transcript. |

`evidence_note` (JSON) / the trailing human line spell out that
"message visible" is not the same as vendor-settled billing.

See `src/usage-events.ts`, `src/usage-collector.ts`, `src/usage-store.ts` and
their tests for the exported contract and coverage.

## Codex

`src/codex-usage-events.ts` is a second, independent pure normalizer for
Codex CLI local session-file telemetry (`~/.codex/sessions/*.jsonl`).
`headroom usage import --format codex` (or `--format auto`, which detects the
Codex transcript shape per line/file) wires it into the same collector, CLI
and `usage.db` schema as Claude — see `test/codex-collector.test.ts` for the
schema-migration and end-to-end import coverage.

What the module does, given one raw JSONL line plus caller-supplied
`(principalKey, sourceKey)` context, exactly like `usage-events.ts`:

- Accepts only `token_usage_record.payload.usage`, the per-response, non-cumulative
  counter block keyed by `response_id` — the structural analogue of Claude's
  `message.id` + `message.usage`. `turn_token_usage` and `thread_token_usage`
  (cumulative-to-date blocks) are read and ignored, never summed or
  differenced.
- Classifies `event_msg`/`token_count` events (`total_token_usage`,
  `last_token_usage`) as skipped — cumulative and/or proven-duplicate with no
  identity to dedup on — rather than guessing at a delta. A single event can
  carry both a skip reason and separate rate-limit observations at once.
- Parses `rate_limits` (`primary`/`secondary` windows) into standalone
  `RateLimitObservation`s: percent, semantic window length, and reset time
  only. `limit_id`, `plan_type`, `credits`, and every other account/plan
  identifier are never parsed into any output field. No relationship between
  a percent reading and any token count is asserted anywhere.
- Reports `model: null` / `modelAttribution: "unavailable_in_record"` always
  — Codex's counter records carry no model field, and the last-seen
  `turn_context.model` is never carried forward onto them.
- Reports every applicable counter-consistency flag at once (e.g.
  `cached_exceeds_input`, `total_mismatch`, `incomplete`) rather than the
  first one found, and asserts no bound for `cache_write_input_tokens` the
  source evidence didn't establish.
- Identity is hashed with an explicit `"codex"` vendor discriminator, so a
  Codex `response_id` can never collide with a Claude identity even if the
  raw strings match.
- Ships its own idempotent revision/dedup accumulator (same
  newer-replaces/older-dropped/tie-is-noop/conflicting-tie-quarantined rules
  as Claude's), duplicated rather than shared, so this module cannot change
  Claude's already-reviewed accumulator semantics.

See `test/codex-usage-events.test.ts` for synthetic-fixture coverage.
Rate-limit observations (`RateLimitObservation`, parsed from `event_msg`'s
`rate_limits` block) are persisted to their own `usage_rate_limit_observations`
table (schema v3), independent of the identity/quarantine machinery above --
each observation's own content hash is its dedup key, so a re-imported line
is a no-op rather than a duplicate row. The module still does not predict
quota consumption from either table; that remains future work.
