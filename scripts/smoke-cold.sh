#!/usr/bin/env bash
set -euo pipefail

root="$(mktemp -d "${TMPDIR:-/tmp}/headroom-cold.XXXXXX")"
archive=""
server_pid=""
cleanup() {
  [[ -n "$server_pid" ]] && kill "$server_pid" 2>/dev/null || true
  [[ -n "$archive" ]] && rm -f "$archive"
  rm -rf "$root"
}
trap cleanup EXIT

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
for _ in {1..50}; do [[ -s "$root/port" ]] && break; sleep 0.05; done
if [[ ! -s "$root/port" ]]; then
  if grep -q "EPERM" "$root/server.err" 2>/dev/null; then echo "SKIP smoke-cold: sandbox forbids listen(2)"; exit 0; fi
  cat "$root/server.err" >&2; exit 1
fi
port="$(head -n1 "$root/port")"
mkdir -p "$root/home/.headroom" "$root/unpack"
printf '[[accounts]]\nname = "fixture-local"\nkind = "local"\nbase_url = "http://127.0.0.1:%s"\nadapter = "native"\n' "$port" >"$root/home/.headroom/accounts.toml"

archive="$(npm pack --silent --cache "$root/npm-cache")"
tar -xzf "$archive" -C "$root/unpack"
output="$(HEADROOM_HOME="$root/home/.headroom" node "$root/unpack/package/dist/cli.js")"
[[ "$output" == *"fixture-local:capacity  UP model=local-27b running=0 waiting=0"* ]]
echo "cold smoke passed"
