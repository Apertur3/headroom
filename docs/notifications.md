# Notifications

Run `headroom notify configure` to choose Telegram, ntfy, a webhook, or several
channels. The same picker is offered after the service step in `headroom setup`.
Notifications stay off until you choose a channel. `setup --yes` skips this step
and prints the command to run later.

## Pick a preset

| Preset | What reaches your phone |
| --- | --- |
| `calm` (default) | Unscheduled resets on any window, weekly resets, free reset credits granted, source failures and recoveries, threshold crossings. |
| `quiet` | Unscheduled resets, source failures and threshold crossings. |
| `everything` | All event kinds, including scheduled 5h resets, projected stalls, new model buckets, historical Keychain grant-lapse events, credit and plan changes, and leases. |

The picker asks one question at a time: channels and destinations, preset,
individual event choices if wanted, quiet hours, then an optional test message.
Enter keeps the displayed answer. Individual questions show both the preset's
default and your current choice. Choosing another preset starts from its defaults.
Use `none` to clear channels or quiet hours.

```sh
headroom notify configure
headroom notify configure --dry-run
headroom notify --test
headroom notify --last 20
```

`--dry-run` prints the proposed notification tables without writing, reading
credentials or sending. Scripted answers can also be piped to the picker, one
answer per line. Settings go into `policy.toml` in your Headroom home. Existing
notification tables are edited in place; other settings, comments and line endings
are preserved. If the file changes while the picker is open, it asks you to run
again instead of overwriting that edit.

## Policy settings

```toml
[notify]
channels = ["telegram", "ntfy"]
preset = "calm"
events_on = ["model_new"]
events_off = ["source_recovered"]
threshold_percent = 90
quiet_hours = "23:00-07:00"

[notify.telegram]
chat_id = "123456"

[notify.ntfy]
topic = "headroom-example"
# server = "https://ntfy.example.com" # default: https://ntfy.sh

# [notify.webhook]
# url = "https://example.com/hook"
```

`events_on` adds choices to the preset; `events_off` removes them and wins if a
name appears in both. Supported names:

| Name | Meaning |
| --- | --- |
| `reset_unscheduled` | An unexpected reset on any window. |
| `reset_scheduled_weekly` | A scheduled weekly reset. |
| `reset_scheduled_short` | A scheduled 5h reset. |
| `reset_seen` | All resets, subject to the short-window rule below. Turning it off disables all resets. |
| `free_reset_granted`, `free_reset_used` | Reset credits granted or consumed. |
| `credits_changed`, `plan_changed` | Credit balance or subscription plan changes. |
| `source_failed`, `source_recovered` | A source stopped answering or is reading again. |
| `threshold` | A fresh hard window reached the used-percent threshold. |
| `pace_projection_conserve` | Recent burn projects exhaustion before reset. Phone alerts fire once per window instance, with at most one materially worse escalation. |
| `model_new` | A new model bucket on a known principal. A principal's first poll stays quiet. |
| `grant_lapsed` | A historical Keychain grant lapse retained for existing event history. |
| `lease_started`, `lease_ended` | Work reservations started or ended. |

Scheduled 5h resets are delivered only with `preset = "everything"` or
`events_on = ["reset_scheduled_short"]`. They happen several times a day, so
`reset_seen` alone does not opt into them. These remain `reset_seen` events in
storage and webhooks: selection reads `metadata.window_minutes` and
`metadata.unscheduled`. Unscheduled 5h resets follow `reset_unscheduled`.
Older reset events without window metadata are included by `everything` or an
explicit `reset_seen` selection.

Older `events = [...]` lists remain readable as a replacement for the preset's
base list, with overrides applied afterward. The picker converts those choices
to a preset and overrides. The old `notify_scheduled_short` setting is accepted
but no longer enables delivery: use `events_on = ["reset_scheduled_short"]`.

`threshold_percent` defaults to 90 and accepts values above 0 through 100.
Threshold notifications fire once per window instance, then wait for a new reset
timestamp. Disable `threshold` in `events_off` to turn them off.

## Phone messages

Each event has an emoji headline, human-readable principal and window names,
whole percentages, and a plain-language consequence, in at most four lines:

```text
🔄 Unscheduled reset
Codex weekly is back to 0% (was 88%) at 03:24.
Plan again: a full week of capacity appeared.
```

```text
🔥 Threshold
Codex weekly crossed 90% (now 91%); resets Sep 10 15:08, in 2d 5h.
CONSERVE until then.
```

Times use the local timezone of the machine running Headroom. Missing facts are
omitted rather than guessed. Historical messages use the event's original
observations. Scheduled resets name the affected window and, when available,
the other window's reading.

Telegram gets plain text with no `parse_mode`. ntfy gets the same body and uses
the emoji headline as its title. The title uses ntfy's supported
[RFC 2047 encoding](https://docs.ntfy.sh/publish/#message-title) to carry emoji
through HTTP headers. Both channels split messages at 3800 characters, preferring
line boundaries. Webhooks still get one JSON object per event, including in a digest:

```json
{"event":"reset_seen","meter":"codex:main","principal":"codex","at":"2026-09-08T01:24:00Z","text":"🔄 Unscheduled reset\nCodex weekly is back to 0% (was 88%) at 03:24.\nPlan again: a full week of capacity appeared."}
```

## Credentials

The picker never asks you to type a bot token into Headroom. It prints the exact
command for your OS. Run it in another terminal, enter the token at the hidden
prompt, then choose the test message. Headroom checks that configured channels
are ready before testing.

| Platform | Store the Telegram bot token |
| --- | --- |
| macOS | `security add-generic-password -U -a headroom -s headroom-telegram -w` |
| Linux | `secret-tool store --label=headroom service headroom-telegram` |
| Windows (PowerShell) | `powershell -NoProfile -Command "cmdkey /generic:headroom-telegram /user:headroom /pass"` |

Tokens stay in the OS secret store. They are read at delivery time, never from
policy files, and there is no plaintext fallback. The optional webhook bearer
uses the same command with `headroom-webhook` instead of `headroom-telegram`.
A missing Telegram token disables Telegram; a missing webhook bearer means the
webhook sends without an Authorization header. Keep credentials out of URLs.

## Delivery and troubleshooting

The daemon delivers after each poll. A ledger deduplicates each event/channel
pair. Its first notification pass records a watermark and skips old backlog.
Tests send outside the ledger and cannot suppress real events.

Quiet hours use local wall-clock time and may wrap midnight. Events are queued
until the first poll outside the range, then arrive under a `🌙 Headroom` headline
with one line per event, even if there was only one. Retries are limited to three
attempts per event; the first failure and the final give-up are logged. Requests
time out after five seconds, redirects are refused, responses are bounded, and
resolved credentials are scrubbed from errors.

If nothing arrives, check that the daemon is running, inspect `headroom logs`,
and run `headroom notify --test`. A disabled channel reports its missing setting
or secret-store problem. `headroom notify --last 20` shows pending, sent and failed
deliveries; a failed row has exhausted its retries and waits for a new event.

A vendor-reported paid-to-free plan downgrade is urgent: it is delivered in every
preset and breaks through quiet hours once, with one reminder after 24 hours if it
is still unacknowledged. Dispatches stay refused until `headroom ack plan <principal>`
confirms an intended downgrade, or until the vendor reports the paid plan again.
A reset credit spent while the plan is free is also delivered immediately.
