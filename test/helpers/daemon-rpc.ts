import { createHmac, randomBytes } from "node:crypto";
import type { HeadroomDaemon } from "../../src/daemon.js";

export interface RpcReply { id?: unknown; result?: unknown; error?: { code: number; message: string } }

function pipeAuthProof(token: string, nonce: string): string {
  return createHmac("sha256", token).update(`headroom-pipe-auth-v1:${nonce}`).digest("hex");
}

/**
 * Calls the daemon's private handleLine() the way a real client would on
 * every platform. On win32 every method but "health" needs the pipe-auth
 * proof of a per-connection nonce, so a test that skips it gets
 * "Unauthorized pipe client" on the Windows runner only. This forces a known
 * session token onto the daemon and signs a fresh nonce, as rpc() does.
 * Tests of the pipe transport itself live in test/pipe-auth.test.ts.
 */
export async function authedHandleLine(daemon: HeadroomDaemon, line: string): Promise<RpcReply> {
  const internal = daemon as unknown as { sessionToken?: string; handleLine(line: string, nonce?: string): Promise<{ replyLine: string }> };
  if (process.platform !== "win32") { const { replyLine } = await internal.handleLine(line); return JSON.parse(replyLine) as RpcReply; }
  internal.sessionToken ??= randomBytes(32).toString("hex");
  const nonce = randomBytes(16).toString("hex");
  let request: { params?: Record<string, unknown> } | null = null;
  try { const parsed: unknown = JSON.parse(line); request = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as { params?: Record<string, unknown> } : null; } catch { request = null; }
  if (!request) { const { replyLine } = await internal.handleLine(line, nonce); return JSON.parse(replyLine) as RpcReply; }
  const params = { ...(request.params ?? {}), _proof: pipeAuthProof(internal.sessionToken, nonce) };
  const { replyLine } = await internal.handleLine(JSON.stringify({ ...request, params }), nonce);
  return JSON.parse(replyLine) as RpcReply;
}
