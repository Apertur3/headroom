# @headroomd/policy

Pure quota pacing and spending decisions, shared with headroomd. No dependencies,
I/O, or implicit clock reads: callers supply readings and the current time.
Requires Node >=20.

```sh
npm install @headroomd/policy
```

```js
import { pace, canRun, holdUntil } from "@headroomd/policy";

const now = new Date("2026-10-18T12:00:00Z");
const readings = [{
  meter: "quota", windowMinutes: 300, usedPercent: 75,
  resetsAt: "2026-10-18T14:30:00Z", fetchedAt: now.toISOString(),
}];
const need = { class: "batch", percent: 15 };
pace(readings, now);           // CONSERVE, binding: "quota"
canRun(need, readings, now);   // ok: false, waitUntil: 13:00Z
holdUntil(need, readings, now); // "2026-10-18T13:00:00.000Z"
```

## API

- `paceState(reading, options | undefined, now)` returns `{ state, reason }`.
- `pace(readings, now, options?)` returns `{ state, reason, binding? }`.
  Tightest wins: FREEZE > UNKNOWN > CONSERVE > NORMAL > HARVEST. Ties bind
  the first reading. Empty readings are UNKNOWN. Rejected status is FREEZE.
- `canRun(need | needs, readings, now, options?)` returns
  `{ ok, state, reason, binding?, waitUntil? }`.
- `holdUntil(need | needs, readings, now, options?)` returns an ISO deadline,
  or `null` when it may run now. Invalid `now` throws a `TypeError` in
  `pace`, `paceState`, `canRun` and `holdUntil`.
- `fromClaudeRateLimitEvent(event, receivedAt)` converts `rate_limit_info`
  into readings for `five_hour` (300 minutes) and `seven_day` (10080 minutes).
  Utilization fractions become percentages. Status applies only to the window
  named by `rateLimitType`; overage status is ignored. Window names starting
  `five_hour` or `seven_day` map to 300 or 10080 minutes and keep their full
  meter name. Missing unified windows fall back to valid top-level fields. A
  `rejected` window is always emitted: `usedPercent: null` without utilization,
  `windowMinutes: 0` for an unknown name (both give FREEZE). Other unknown
  names are skipped.

`MeterReading` has `meter`, `windowMinutes`, `usedPercent` (number or null),
`resetsAt` (ISO string or null), `fetchedAt` (ISO string), optional `status`
(`allowed`, `allowed_warning`, `rejected`) and optional `burnPercentPerHour`.
`Need` has `class` and optional `neverHold`, `percent`, `windowMinutes`.
`PaceState`, `MeterReading`, `PolicyOptions` and `Need` are exported types.

Each need uses readings matching its `windowMinutes`, when specified; no match
means UNKNOWN. Otherwise it uses all readings. `neverHold` always allows the
need while reporting its pace. FREEZE and UNKNOWN refuse; NORMAL and HARVEST
allow. CONSERVE allows unless `percent` is finite and **any** relevant reading
with usable `usedPercent` satisfies either:

- `usedPercent + percent >= 100 - freezeReservePercent`, or
- `burnPercentPerHour > 0` and
  `(100 - usedPercent - percent) / burnPercentPerHour * 3600` is less than
  the seconds until that reading's `resetsAt`.

Without a finite `percent`, CONSERVE allows. Among refused needs the tightest
state wins; if all allow, the tightest allowed state wins. An empty needs list is gated by pace like a
no-cost background job. A `percent` that is negative or not a number counts as 0.
A `fetchedAt` more than 5 minutes ahead of `now` is UNKNOWN (clock skew). `class` is a caller label.

`defaultPolicyOptions`: `stalenessMinutes: 15`, `freezeReservePercent: 10`,
`paceGraceFraction: 0.10`, `conserveHoldMinutes: 60`, `unknownRecheckMinutes: 5`.
Each option is independently optional. Invalid numeric options use defaults;
`conserveHoldMinutes` and `unknownRecheckMinutes` are clamped to 1..1440.

A CONSERVE refusal holds for `conserveHoldMinutes`, capped by the binding
reading's future reset. FREEZE holds until its future reset, or rechecks after
`unknownRecheckMinutes` if the reset is absent, invalid, past or more than one window away. UNKNOWN always
rechecks after `unknownRecheckMinutes`.

See the [Headroom documentation](https://github.com/Apertur3/headroom/tree/main/docs)
for the pacing model. The canonical core lives in `src/core.ts`; regenerate
headroomd's copy from the repository root with `npm run sync:pace-core`.
