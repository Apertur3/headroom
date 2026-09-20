# Usage-based prediction — ingestion foundation

This is a **foundation for future work**, not a shipped feature. There is no
live collector reading real transcripts yet, and no predictor turning token
counts into a percent-of-limit or a pace state. Nothing described here is
wired into `headroom`, the daemon, or any CLI/MCP surface.

## What exists today

`src/usage-events.ts` is a small, pure TypeScript module (no filesystem
access, no dependencies, no vendor calls) that:

- Normalizes the numeric usage counters Anthropic's API reports on a Claude
  Code assistant transcript line (`input_tokens`, `output_tokens`,
  `cache_read_input_tokens`, `cache_creation_input_tokens`, and the
  `cache_creation` TTL breakdown), rejecting anything that isn't a finite,
  nonnegative, safe integer with a structured reason instead of guessing.
- Parses one raw JSONL line at a time, bounded by size, and returns a
  snapshot, a recognized-but-irrelevant skip, or a safely-diagnosed rejection
  — never the raw line content, in success or failure.
- Deduplicates and folds revisions of the same assistant message (by an
  opaque local identity, never a raw vendor id) into an idempotent
  accumulator: newer, later-observed revisions replace older ones (including
  legitimate downward corrections), out-of-order older data never overwrites
  newer data, and same-version conflicts or a model change under the same
  identity are quarantined rather than merged.

## What this is not

- Not a collector: nothing here reads `~/.claude*/projects/**/*.jsonl` or any
  other file. A caller supplies raw line text plus already-trusted, already-safe
  source/principal context.
- Not a predictor: no token-to-percent conversion, no pace state, no
  relationship to a vendor's actual quota. A message being visible in a
  transcript is not proof the vendor's own billing/accounting has settled it.
  This is not final billing data.
- Not a coverage guarantee: this ingests whatever lines a future collector
  hands it. It makes no claim about having seen a whole transcript, a whole
  session, or a whole subscription's usage.

See `src/usage-events.ts` and `test/usage-events.test.ts` for the exported
contract and its test coverage.
