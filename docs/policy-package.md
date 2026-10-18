# @headroomd/policy

A tiny, pure package with Headroom's pace decision and a can-I-run check, for apps that
read their own rate-limit data and want the same states headroomd shows. It has no
dependencies, no Node built-ins, no I/O and no hidden clock: you pass readings and the
current time. MIT, ESM plus `.d.ts`, Node 24.18 or newer.

```sh
npm install @headroomd/policy
```

## States

`HARVEST`, `NORMAL`, `CONSERVE`, `FREEZE`, `UNKNOWN`. headroomd uses the same core
(`paceCore`), so a reading gives the same state in both. The decision, in order:

1. `status: "rejected"` is `FREEZE`, whatever the utilization.
2. A missing, stale (older than `stalenessMinutes`, default 15) or unparseable reading is `UNKNOWN`.
3. `usedPercent >= 100 - freezeReservePercent` (default 10) is `FREEZE`.
4. A missing `resetsAt` is `UNKNOWN`.
5. Inside the first `paceGraceFraction` (default 0.10) of the window it is `NORMAL`, unless a burn
   projection says the window empties within 30 minutes.
6. If `burnPercentPerHour` is given and the window would run dry before it resets, `CONSERVE`.
7. Otherwise the surplus (unused share minus the share of the window still ahead) decides:
   above +10% `HARVEST`, below -10% `CONSERVE`, else `NORMAL`.

Any change to a state or its meaning is a major version.

## API

- `paceState(reading, options, now)` returns `{ state, reason }`.
- `pace(readings, now, options?)` returns the tightest state and the binding meter.
  Order: FREEZE, UNKNOWN, CONSERVE, NORMAL, HARVEST. An UNKNOWN reading never makes the result
  more permissive.
- `canRun(need, readings, now, options?)` returns `{ ok, state, reason, waitUntil?, binding? }`.
- `holdUntil(need, readings, now, options?)` returns an ISO time or `null`.
- `fromClaudeRateLimitEvent(evt, receivedAt)` turns a Claude `rate_limit_event` into readings
  (`five_hour` = 300 min, `seven_day` = 10080 min). It never throws; unusable input gives `[]`,
  which `pace` reads as UNKNOWN.

### canRun

A need is `{ class, neverHold?, percent?, windowMinutes? }` (or an array). Costs are inputs; nothing is learned.

- `neverHold` is always ok, but still reports the state.
- FREEZE and UNKNOWN are not ok. NORMAL and HARVEST are ok.
- CONSERVE is ok unless `percent` is given and, for any relevant reading, either
  `used + percent >= 100 - freezeReservePercent`, or `burnPercentPerHour > 0` and
  `(100 - used - percent) / burn * 3600` is less than the seconds until `resetsAt`.
  Without `percent`, CONSERVE is ok.

### holdUntil

Null when the need can run. CONSERVE holds at most `conserveHoldMinutes` (default 60, never past the
reset) so held work runs as one batch. FREEZE holds until the binding window's `resetsAt`. UNKNOWN
rechecks after `unknownRecheckMinutes` (default 5), never forever.

## Releases

The package is versioned independently of headroomd (`packages/policy/CHANGELOG.md`). The release
workflow publishes it with provenance when its version is not on npm yet.
