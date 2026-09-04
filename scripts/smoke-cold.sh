#!/usr/bin/env bash
# Cold-install smoke test: build, pack, install the tarball globally into a
# throwaway prefix, then drive the installed `headroom` binary the way a real
# user would -- no source tree, no network, no real credentials, no ~/.headroom.
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

root="$(mktemp -d "${TMPDIR:-/tmp}/headroom-cold.XXXXXX")"
server_pid=""
failures=0

cleanup() {
  if [[ -n "$server_pid" ]]; then
    kill "$server_pid" 2>/dev/null || true
    wait "$server_pid" 2>/dev/null || true
  fi
  rm -rf "$root"
}
trap cleanup EXIT

pass() { echo "PASS $1"; }
fail() { echo "FAIL $1: $2"; failures=$((failures + 1)); }

# expect_exit CODE MIN MAX -- accepts any exit code in [MIN, MAX]
in_range() { [[ "$1" -ge "$2" && "$1" -le "$3" ]]; }

# --- step: build -----------------------------------------------------------
if npm run build >"$root/build.log" 2>&1; then
  pass "build"
else
  fail "build" "npm run build failed; see $root/build.log"
  cat "$root/build.log" >&2
  exit 1
fi

# --- step: npm pack ----------------------------------------------------------
tarball_dir="$root/tarball"
mkdir -p "$tarball_dir"
if tarball_name="$(npm pack --silent --pack-destination "$tarball_dir" 2>"$root/pack.log")"; then
  tarball="$tarball_dir/$tarball_name"
  pass "npm pack ($tarball_name)"
else
  fail "npm pack" "see $root/pack.log"
  cat "$root/pack.log" >&2
  exit 1
fi

# --- step: global install from the tarball, into an isolated prefix --------
prefix="$root/prefix"
install_home="$root/npm-home"
npm_cache="$root/npm-cache"
mkdir -p "$prefix" "$install_home" "$npm_cache"
if HOME="$install_home" npm install -g --prefix "$prefix" --offline --no-audit --no-fund \
  --cache "$npm_cache" "$tarball" >"$root/install.log" 2>&1; then
  pass "npm install -g --prefix (offline, isolated HOME)"
else
  fail "npm install -g" "see $root/install.log"
  cat "$root/install.log" >&2
  exit 1
fi

headroom_bin="$prefix/bin/headroom"
if [[ ! -x "$headroom_bin" ]]; then
  fail "installed binary" "$headroom_bin not found or not executable"
  exit 1
fi

# --- fixture: one local pool, backed by a stub HTTP server, no real network -
node --input-type=module -e '
  import { createServer } from "node:http";
  const server = createServer((request, response) => {
    if (request.url === "/v1/models") {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ data: [{ id: "local-27b" }] })); return;
    }
    if (request.url === "/metrics") { response.end("vllm:num_requests_running 0\nvllm:num_requests_waiting 0\n"); return; }
    if (request.url === "/health") { response.end("ok"); return; }
    response.statusCode = 404; response.end();
  });
  server.listen(0, "127.0.0.1", () => console.log(server.address().port));
' >"$root/port" 2>"$root/server.err" &
server_pid=$!
for _ in $(seq 1 50); do [[ -s "$root/port" ]] && break; sleep 0.05; done
if [[ ! -s "$root/port" ]]; then
  if grep -q "EPERM" "$root/server.err" 2>/dev/null; then
    echo "SKIP smoke-cold: sandbox forbids listen(2)"
    exit 0
  fi
  fail "stub server" "did not start; see $root/server.err"
  cat "$root/server.err" >&2
  exit 1
fi
port="$(head -n1 "$root/port")"
pass "stub local pool listening on 127.0.0.1:$port"

user_home="$root/home"
headroom_home="$user_home/.headroom"
mkdir -p "$user_home"
mkdir -m 700 -p "$headroom_home"
printf '[[accounts]]\nname = "fixture-local"\nkind = "local"\nbase_url = "http://127.0.0.1:%s"\nadapter = "native"\n' "$port" >"$headroom_home/accounts.toml"

export HOME="$user_home"
export HEADROOM_HOME="$headroom_home"

# --- step: headroom doctor --------------------------------------------------
# A cold install with no daemon running legitimately reports FAIL checks (no
# socket, no engine); doctor exits 1 in that case and 0 when everything is
# healthy. Either is a real, non-crashing result -- anything else is a bug.
set +e
doctor_out="$("$headroom_bin" doctor 2>&1)"; doctor_code=$?
set -e
if in_range "$doctor_code" 0 1; then
  pass "headroom doctor (exit $doctor_code)"
else
  fail "headroom doctor" "exit $doctor_code: $doctor_out"
fi

# --- step: headroom (bare) --------------------------------------------------
set +e
bare_out="$("$headroom_bin" 2>&1)"; bare_code=$?
set -e
up_lines="$(printf '%s\n' "$bare_out" | grep -c "fixture-local:capacity  UP model=local-27b running=0 waiting=0" || true)"
if [[ "$bare_code" -eq 0 && "$up_lines" -eq 1 ]]; then
  pass "headroom (one UP line)"
else
  fail "headroom" "exit $bare_code, UP lines=$up_lines: $bare_out"
fi

# --- step: headroom --json --------------------------------------------------
set +e
json_out="$("$headroom_bin" --json 2>&1)"; json_code=$?
set -e
json_line="$(printf '%s\n' "$json_out" | tail -n1)"
if [[ "$json_code" -eq 0 ]] && printf '%s' "$json_line" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null; then
  pass "headroom --json"
else
  fail "headroom --json" "exit $json_code: $json_out"
fi

# --- step: headroom events --since 1h ---------------------------------------
set +e
events_out="$("$headroom_bin" events --since 1h 2>&1)"; events_code=$?
set -e
events_line="$(printf '%s\n' "$events_out" | tail -n1)"
if [[ "$events_code" -eq 0 ]] && printf '%s' "$events_line" | node -e 'JSON.parse(require("fs").readFileSync(0,"utf8"))' 2>/dev/null; then
  pass "headroom events --since 1h"
else
  fail "headroom events --since 1h" "exit $events_code: $events_out"
fi

# --- step: headroom mcp, piped initialize + tools/list ----------------------
mcp_request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-cold","version":"0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
set +e
mcp_out="$(printf '%s\n' "$mcp_request" | "$headroom_bin" mcp 2>&1)"; mcp_code=$?
set -e
if [[ "$mcp_code" -eq 0 ]] && printf '%s' "$mcp_out" | grep -q '"protocolVersion"' && printf '%s' "$mcp_out" | grep -q '"tools"'; then
  pass "headroom mcp (initialize + tools/list)"
else
  fail "headroom mcp" "exit $mcp_code: $mcp_out"
fi

if [[ "$failures" -eq 0 ]]; then
  echo "cold smoke passed"
  exit 0
fi
echo "cold smoke failed ($failures step(s))"
exit 1
