## [1.0.0]

Initial release.

- Pure `pace`, `paceState`, `canRun`, `holdUntil` and `fromClaudeRateLimitEvent`; Node >=20.
- Fail closed: negative usage and a `fetchedAt` over 5 minutes ahead are UNKNOWN; a `rejected` window is always FREEZE, even without utilization or with an unknown name.
- Empty needs are gated by pace. `holdUntil` returns null only when the need may run now; hold and recheck minutes are clamped to 1..1440. Invalid `now` throws a `TypeError`.
