# @headroomd/policy

A tiny, pure package with Headroom's pace decision and a can-I-run check, for apps that
read their own rate-limit data and want the same states headroomd shows. It has no
dependencies, no Node built-ins, no I/O and no hidden clock: you pass readings and the
current time. MIT, ESM plus `.d.ts`, Node 20 or newer.

```sh
npm install @headroomd/policy
```

## States

`HARVEST`, `NORMAL`, `CONSERVE`, `FREEZE`, `UNKNOWN`. headroomd uses the same core
(`paceCore`), so a reading gives the same state in both. The decision, in order:

1. `status: "rejected"` is `FREEZE`, whatever the utilization.
2. A missing, negative, stale (older than `stalenessMinutes`, default 15) or unparseable reading is `UNKNOWN`.
   So is a `fetchedAt` more than 5 minutes in the future ("clock skew").
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
- `holdUntil(need, readings, now, options?)` returns an ISO time, or `null`, which means it may run now.
  An invalid `now` is a programmer error: `canRun`, `holdUntil`, `pace` and `paceState` throw a `TypeError`.
- `fromClaudeRateLimitEvent(evt, receivedAt)` turns a Claude `rate_limit_event` into readings
  (names starting `five_hour` = 300 min, `seven_day` = 10080 min; the meter keeps the full name, e.g.
  `seven_day_opus`). A `rejected` status is never dropped: without utilization the reading has
  `usedPercent: null` (FREEZE), and an unknown window name gets `windowMinutes: 0`. Other unknown
  names are skipped. It never throws; unusable input gives `[]`, which `pace` reads as UNKNOWN.

### canRun

A need is `{ class, neverHold?, percent?, windowMinutes? }` (or an array). Costs are inputs; nothing is learned.

- `neverHold` is always ok, but still reports the state. An empty list of needs is gated by pace
  like a no-cost background job.
- A `percent` that is negative or not a number counts as 0.
- FREEZE and UNKNOWN are not ok. NORMAL and HARVEST are ok.
- CONSERVE is ok unless `percent` is given and, for any relevant reading, either
  `used + percent >= 100 - freezeReservePercent`, or `burnPercentPerHour > 0` and
  `(100 - used - percent) / burn * 3600` is less than the seconds until `resetsAt`.
  Without `percent`, CONSERVE is ok.

### holdUntil

Null means it may run now; a refused need always gets a finite future time. CONSERVE holds at most
`conserveHoldMinutes` (default 60, never past the reset) so held work runs as one batch. FREEZE holds
until the binding window's `resetsAt` (if within one window), else rechecks. UNKNOWN rechecks after
`unknownRecheckMinutes` (default 5). Both minute options are clamped to 1..1440.

## Releases

The package is versioned independently of headroomd (`packages/policy/CHANGELOG.md`). The release
workflow publishes it with provenance when its version is not on npm yet.
