# Dispatch guard

Every dispatched lane should go through `headroom run`. It checks the meter before the process starts, takes a lease for the expected cost, passes through the command's standard input, output, error stream and environment, then ends the lease when the command exits.

On September 8 and 9, two orchestration sessions kept dispatching Codex work while the monthly allowance was filling. Neither session gated its lane or took a lease, and the usage response initially exposed only the short and weekly windows. The account then reached its 30-day limit, so Headroom now treats every vendor-reported window as dispatch-critical.

```sh
headroom run --meter codex-main:main --need 30d:4 --owner planner --ttl 3h -- codex exec "Implement the reviewed slice"
```

```sh
headroom run --meter claude-main:all --need 5h:3 --need wk:1 --owner orchestrator --class implementation -- claude -p "Work on the assigned subagent task"
```

`--class implementation` can be used without `--need` after Headroom has learned a cost for that class. MCP clients use the equivalent pair, `quota_gate` followed by `quota_lease_start`, before launching their lane. Never launch a lane on a meter that has not passed one of those checks.

If a wrapped command reports a vendor limit, Headroom records the exhaustion and refuses new dispatches until the reported reset. A script can report the same fact directly with `headroom report --meter <meter> --exhausted --until <timestamp>` or by writing `HEADROOM_EXHAUSTED_UNTIL=<timestamp>`.
