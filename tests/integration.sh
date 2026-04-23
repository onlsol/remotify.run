#!/usr/bin/env bash
#
# End-to-end integration tests for the remotify relay. Hits a running stack
# (by default the local docker-compose on remotify.localtest.me:49180) with
# curl and asserts on status codes + response bodies.
#
# Prereqs:
#   docker compose up -d
#
# Run:
#   ./tests/integration.sh                  # against local stack
#   REMOTIFY_BASE=https://remotify.run ./tests/integration.sh   # against public
#
# Exit status:
#   0 all green, 1 at least one failure.

set -u
BASE="${REMOTIFY_BASE:-http://remotify.localtest.me:49180}"
CURL=(curl -sS)

PASS=0
FAIL=0
FAILED_NAMES=()

green='\033[32m'; red='\033[31m'; dim='\033[2m'; reset='\033[0m'
ok()   { printf "  ${green}ok${reset}  %s\n" "$1"; PASS=$((PASS + 1)); }
nok()  { printf "  ${red}FAIL${reset} %s\n      %s\n" "$1" "$2"; FAIL=$((FAIL + 1)); FAILED_NAMES+=("$1"); }
banner(){ printf "\n${dim}-- %s --${reset}\n" "$1"; }
eq()   { [ "$1" = "$2" ] && ok "$3" || nok "$3" "expected [$1], got [$2]"; }
contains() { case "$2" in *"$1"*) ok "$3" ;; *) nok "$3" "output missing: $1" ;; esac; }

# Wait for the stack to respond with 200 on /api/health. A fresh
# 'docker compose up --build' returns 502 for the first few seconds
# while nginx warms up its upstream; re-trying until healthy keeps
# CI runs stable without discarding a warmup pass.
printf "waiting for %s to be ready..." "$BASE"
for _ in $(seq 1 30); do
  code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/health" 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then printf " ok\n"; break; fi
  printf "."
  sleep 0.5
done
if [ "$code" != "200" ]; then
  printf "\nstack at %s never returned 200 on /api/health; aborting\n" "$BASE" >&2
  exit 1
fi

# Always clean up any session we created.
SESSIONS=()
cleanup() {
  for k in "${SESSIONS[@]:-}"; do
    "${CURL[@]}" -X DELETE "$BASE/api/session/$k" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT

# ---------------------------------------------------------------------------
banner "health"
code=$("${CURL[@]}" -o /tmp/.r.out -w '%{http_code}' "$BASE/api/health")
eq 200 "$code" "GET /api/health -> 200"
contains '"ok": true' "$(cat /tmp/.r.out)" "health body says ok"

# ---------------------------------------------------------------------------
banner "session lifecycle"
resp=$("${CURL[@]}" -o /tmp/.r.out -w '%{http_code}' -X POST "$BASE/api/session")
eq 201 "$resp" "POST /api/session -> 201"
KEY=$(grep -oE '"key": *"[a-f0-9]+"' /tmp/.r.out | head -1 | sed -E 's/.*"([a-f0-9]+)".*/\1/')
SESSIONS+=("$KEY")
eq 32 "${#KEY}" "key is 32 hex chars"

payload=$(cat /tmp/.r.out)
contains "\"remote_quickstart\"" "$payload"  "payload has remote_quickstart"
contains "\"urls\"" "$payload"               "payload has urls"
contains "/cmd-$KEY" "$payload"              "urls.cmd carries key"
contains "/result-$KEY" "$payload"           "urls.result carries key"
contains "/r/$KEY" "$payload"                "urls.runner carries key"
contains "/api/session/$KEY" "$payload"      "urls.api carries key"

code=$("${CURL[@]}" -o /tmp/.r.out -w '%{http_code}' "$BASE/api/session/$KEY")
eq 200 "$code" "GET /api/session/{key} -> 200"
contains "\"key\": \"$KEY\"" "$(cat /tmp/.r.out)" "re-fetch returns same key"

# ---------------------------------------------------------------------------
banner "status probe"
code=$("${CURL[@]}" -o /tmp/.r.out -w '%{http_code}' "$BASE/api/session/$KEY/status")
eq 200 "$code" "GET status -> 200"
body=$(cat /tmp/.r.out)
contains '"cmd_queued": false'    "$body" "fresh session: cmd_queued=false"
contains '"result_queued": false' "$body" "fresh session: result_queued=false"

# ---------------------------------------------------------------------------
banner "cmd push/consume"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST --data-raw 'echo hello' "$BASE/cmd-$KEY")
eq 201 "$code" "POST /cmd-{key} -> 201"

body=$("${CURL[@]}" "$BASE/api/session/$KEY/status")
contains '"cmd_queued": true' "$body" "cmd_queued=true after push"

# GET consumes the hot slot (this is what the listener does).
code=$("${CURL[@]}" -o /tmp/.r.out -w '%{http_code}' "$BASE/cmd-$KEY")
eq 200 "$code" "GET /cmd-{key} -> 200"
eq "echo hello" "$(cat /tmp/.r.out)" "GET body matches pushed cmd"

body=$("${CURL[@]}" "$BASE/api/session/$KEY/status")
contains '"cmd_queued": false' "$body" "cmd_queued=false after consume"

code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/cmd-$KEY")
eq 204 "$code" "GET /cmd-{key} on empty -> 204"

# ---------------------------------------------------------------------------
banner "result push/consume"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST --data-raw 'some output' "$BASE/result-$KEY")
eq 201 "$code" "POST /result-{key} -> 201"

code=$("${CURL[@]}" -o /tmp/.r.out -w '%{http_code}' "$BASE/result-$KEY")
eq 200 "$code" "GET /result-{key} -> 200"
eq "some output" "$(cat /tmp/.r.out)" "result body matches"

# ---------------------------------------------------------------------------
banner "gzip-encoded push"
printf 'gzipped body' | gzip -c > /tmp/.gz
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X POST \
      -H 'Content-Encoding: gzip' --data-binary @/tmp/.gz "$BASE/result-$KEY")
eq 201 "$code" "POST gzip /result-{key} -> 201"
eq "gzipped body" "$("${CURL[@]}" "$BASE/result-$KEY")" "gzip body decoded correctly"

# ---------------------------------------------------------------------------
banner "last-wins rotation"
"${CURL[@]}" -o /dev/null -X POST --data-raw 'first' "$BASE/cmd-$KEY"
"${CURL[@]}" -o /dev/null -X POST --data-raw 'second' "$BASE/cmd-$KEY"
got=$("${CURL[@]}" "$BASE/cmd-$KEY")
eq "second" "$got" "hot slot holds latest push"

# ---------------------------------------------------------------------------
banner "DELETE /cmd-{key} drains without consuming"
"${CURL[@]}" -o /dev/null -X POST --data-raw 'to-be-dropped' "$BASE/cmd-$KEY"
contains '"cmd_queued": true' "$("${CURL[@]}" "$BASE/api/session/$KEY/status")" "queued before DELETE"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/cmd-$KEY")
eq 204 "$code" "DELETE /cmd-{key} -> 204"
contains '"cmd_queued": false' "$("${CURL[@]}" "$BASE/api/session/$KEY/status")" "queued=false after DELETE"

# ---------------------------------------------------------------------------
banner "runner scripts"
body=$("${CURL[@]}" "$BASE/r/$KEY")
contains '#!/usr/bin/env bash' "$body" "supervised runner starts with shebang"
contains '[supervised]' "$body" "supervised runner self-identifies"
contains '[yY]*' "$body" "supervised runner uses the lenient y match"
contains "KEY='$KEY'" "$body" "runner embeds the session key"

body=$("${CURL[@]}" "$BASE/r/$KEY?mode=auto")
contains '[auto]' "$body" "auto runner self-identifies"
contains '>>> %s' "$body" "auto runner prints cmd preview"
contains '<<< done' "$body" "auto runner prints completion marker"
contains 'DEBIAN_FRONTEND=noninteractive' "$body" "runner exports non-interactive env"

# ---------------------------------------------------------------------------
banner "negative / edge cases"

# Well-formed but unknown 32-hex key -> 410.
UNKNOWN=$(printf '%032d' 0)
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/session/$UNKNOWN")
eq 410 "$code" "GET on unknown key -> 410"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/session/$UNKNOWN/status")
eq 410 "$code" "status on unknown key -> 410"

# Malformed key (not 32 hex) -> 404 (route doesn't match).
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/session/not-a-key")
eq 404 "$code" "GET on malformed key -> 404"

# ---------------------------------------------------------------------------
banner "session delete"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' -X DELETE "$BASE/api/session/$KEY")
eq 204 "$code" "DELETE /api/session/{key} -> 204"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE/api/session/$KEY")
eq 410 "$code" "subsequent GET -> 410"
# Don't try to re-clean this one in trap; it's already purged.
SESSIONS=("${SESSIONS[@]/$KEY}")

# ---------------------------------------------------------------------------
banner "summary"
TOTAL=$((PASS + FAIL))
if [ "$FAIL" -eq 0 ]; then
  printf "${green}%d/%d passed${reset}\n" "$PASS" "$TOTAL"
  exit 0
fi
printf "${red}%d/%d passed, %d failed${reset}\n" "$PASS" "$TOTAL" "$FAIL"
for n in "${FAILED_NAMES[@]}"; do printf "  - %s\n" "$n"; done
exit 1
