# Notifications

Headroom already records events: resets it saw, free resets granted or used, a
source that failed or recovered, a window projected to stall, a plan or credit
change, and a model bucket a vendor has not reported before. This page is about
getting those to a human, over Telegram, [ntfy](https://ntfy.sh), or your own
webhook.

Delivery happens in the daemon, after each poll. Nothing is delivered twice: a
ledger in Headroom's own database holds one row per event per channel, and a
row that was sent is never sent again.

## Configure

Notifications are off until `~/.headroom/policy.toml` has a `[notify]` section
naming at least one channel. `examples/policy.toml` ships the same block,
commented out.

```toml
[notify]
channels = ["telegram", "ntfy", "webhook"]
events = ["reset_seen", "free_reset_granted", "source_failed", "source_recovered", "pace_projection_conserve", "model_new", "threshold"]
threshold_percent = 90            # notify when any hard window crosses this used percent
quiet_hours = "23:00-07:00"       # local time; batch instead of send

[notify.telegram]
chat_id = "123456"                # the bot token comes from the OS secret store

[notify.ntfy]
topic = "headroom-example"
# server = "https://ntfy.example.com"   # defaults to https://ntfy.sh

[notify.webhook]
url = "https://example.com/hook"  # POST JSON
```

| Key | Meaning |
| --- | --- |
| `channels` | Which channels to deliver over. Unknown names are a config error. |
| `events` | Event kinds to deliver, plus the synthetic `threshold`. Defaults to resets, free-reset grants, source failures and recoveries, projected stalls, `model_new` and `threshold`. |
| `threshold_percent` | Notify when a hard window is at or above this used percent. Once per window instance: the next message for that window waits until the window has reset. |
| `quiet_hours` | Local wall-clock range, wrapping midnight allowed. Events inside it are queued and go out as one batched message at the end of the window. |

Every stored event kind can be listed: `reset_seen`, `free_reset_granted`,
`free_reset_used`, `credits_changed`, `plan_changed`, `source_failed`,
`source_recovered`, `lease_started`, `lease_ended`,
`pace_projection_conserve`, `model_new`.

`model_new` fires when a vendor reports a bucket name Headroom has never seen
for that principal, which is how a new model release shows up: Claude's
`limits[]` display names are already stored as meters, so a new one appearing
on an account Headroom has been reading is a new named allowance. The first
poll of a brand new account reports every meter as a normal reading instead,
so adding an account does not produce a burst.

## Credentials

The Telegram bot token and the optional webhook bearer are read from the OS
secret store at send time and are never read from a file. If no store is
available, the channel is disabled with a reason in the daemon log and in
`headroom notify --test`. There is no plaintext fallback.

Store them once, under the service name Headroom looks for
(`headroom-telegram` for the bot token, `headroom-webhook` for the webhook
bearer):

| Platform | Store | Read (what Headroom runs) |
| --- | --- | --- |
| macOS | `security add-generic-password -U -a headroom -s headroom-telegram -w` | `security find-generic-password -a headroom -s headroom-telegram -w` |
| Linux | `secret-tool store --label=headroom service headroom-telegram` | `secret-tool lookup service headroom-telegram` |
| Windows | `cmdkey /generic:headroom-telegram /user:headroom /pass` | a PowerShell `CredRead` call against the same Credential Manager entry |

The macOS and Linux commands prompt for the value instead of taking it on the
command line, so the secret never lands in shell history. Headroom spawns the
read command with an argument vector, never through a shell.

A webhook without a stored bearer still posts, with no `Authorization` header.
Telegram without a stored token is disabled, since there is nothing to
authenticate with.

## What each channel receives

**Telegram** posts to `api.telegram.org/bot<token>/sendMessage` with
`{"chat_id": ..., "text": ...}`. Plain text, no `parse_mode`, so nothing in a
meter name or a failure reason can be read as markup. Messages are chunked
under 3800 characters, on line boundaries where possible.

**ntfy** posts the message body to `<server>/<topic>` with a `Title: Headroom`
header, chunked the same way.

**Webhook** posts one JSON object per event:

```json
{ "event": "reset_seen", "meter": "claude-main:all", "principal": "claude-main", "at": "2026-09-06T12:01:00Z", "text": "reset_seen claude-main:all" }
```

## Commands

```sh
headroom notify --test      # one message per configured channel, printing the result
headroom notify --last 20   # the delivery ledger, newest first
```

`--test` sends outside the ledger, so a test message can never suppress a real
one. `--last` prints one line per row: when it was last touched, the channel,
the status (`sent`, `pending`, `failed`), how many attempts it took, and the
message.

## Delivery rules

- **Once.** Every (event, channel) pair is a unique ledger row. Re-polling,
  restarting the daemon, or a second poll inside the same minute cannot resend.
- **No backlog on first run.** The first pass after you enable notifications
  only records a watermark. You get what happens next, not last week.
- **Quiet hours batch.** Events inside the range are queued, then sent as one
  message (`Headroom: 3 events`, one line each) at the first poll after it.
- **Retries are bounded.** A failing channel costs each queued event one
  attempt and is retried on the next poll, at most three attempts per event.
  The first failure and the give-up are written to the daemon log; the outage
  is not re-logged on every poll in between.
- **Every call goes through the outbound guard.** The host must be on the
  allowlist for that channel (`api.telegram.org`, your ntfy server, your
  webhook host), redirects are refused rather than followed, the response is
  read up to 8 KiB, and the request times out after 5 seconds.
- **Secrets never reach a log.** Error text is scrubbed of the resolved
  credential before it is written to the ledger, the daemon log, or the
  terminal.

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| `notify telegram disabled: headroom-telegram is not in the secret store` | Store the bot token with the command above. |
| `notify <channel> disabled: no chat_id / no topic / no url` | The channel is named in `channels` but its own table is missing or incomplete. |
| `Outbound host is not allowed` in the ledger | The webhook or ntfy URL in policy.toml is not the host the response came back from. |
| Nothing arrives, ledger empty | Notifications only run in the daemon. Check `headroom logs` and that the daemon is running. |
| A row stuck at `failed` | Three attempts failed. Fix the channel, then wait for the next event: a failed row is not retried. |
