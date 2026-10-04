/**
 * How long a graceful daemon stop can take, end to end, and so how long a caller that asked the
 * daemon to shut down must keep waiting before it calls the daemon "still running". Kept in its own
 * module so service.ts and uninstall.ts can use it without loading the whole daemon.
 *
 * `headroom daemon` (cli.ts) runs HeadroomDaemon.stop() for a shutdown request or a signal. stop()
 * awaits the keepalive stop, the engine-group sweep, the background drain (capped at 5 s), and the
 * pipe close, which waits for open connections. Its parts are each bounded but their sum is not
 * fixed, so the entry point caps the whole stop: the process exits on its own DAEMON_STOP_DEADLINE_MS
 * after the stop began. When stop() finishes in time, the process exits by itself, or at the latest
 * DAEMON_POST_STOP_EXIT_MS later if a stray handle lingers. The worst case is a stop that finishes
 * just before the deadline and then waits out the post-stop timer.
 */
export const DAEMON_STOP_DEADLINE_MS = 20_000;
export const DAEMON_POST_STOP_EXIT_MS = 2_000;
export const DAEMON_STOP_BUDGET_MS = DAEMON_STOP_DEADLINE_MS + DAEMON_POST_STOP_EXIT_MS;
/** What callers wait for an accepted shutdown: the daemon's worst case plus a margin for a slow host. */
export const DAEMON_STOP_WAIT_MS = DAEMON_STOP_BUDGET_MS + 5_000;
