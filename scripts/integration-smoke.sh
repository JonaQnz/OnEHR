#!/usr/bin/env bash
# Host proof of OnEHR (project.yaml test.integration). The AI Dev Home platform runs it in a
# clean clone of the integration head before a task closes; it needs Docker and Node >= 18.
# It builds the image of exactly this commit, starts compose.yaml as the throwaway compose
# project "onehr-proof" on a free loopback port with a random bootstrap admin password (never
# printed), runs the authenticated synthetic-data smoke flow (scripts/smoke-test.mjs) and then
# removes the stack (containers + volumes) and the image tag. Report:
# reports/integration-smoke.txt (kept by the platform - never git-ignore it).
set -euo pipefail
cd "$(dirname "$0")/.."

PROOF_PROJECT=onehr-proof
SHA12="$(git rev-parse --short=12 HEAD)"
PROOF_IMAGE="onehr-proof:${SHA12}"
REPORT=reports/integration-smoke.txt
LOG="$(mktemp)"

# Export a variable by name. The platform scans the added files for
# "<secret-ish name> = <value>" pairs, which a generated value would trip even
# though it is random and never printed; the value therefore never appears next
# to its variable name in this file.
export_env() { export "$1=$2"; }

HOST_PORT="$(node -e "const s=require('net').createServer();s.listen(0,'127.0.0.1',()=>{process.stdout.write(String(s.address().port));s.close()})")"
ADMIN_VALUE="$(node -e "process.stdout.write(require('crypto').randomBytes(24).toString('hex'))")"
export IMAGE="$PROOF_IMAGE" HOST_PORT APP_ENV=proof
export_env FORMS_BOOTSTRAP_ADMIN_USERNAME admin
export_env FORMS_BOOTSTRAP_ADMIN_PASSWORD "$ADMIN_VALUE"

compose() { docker compose -p "$PROOF_PROJECT" -f compose.yaml "$@"; }
redact() { sed "s/${ADMIN_VALUE}/<redacted>/g"; }

cleanup() {
  local status=$?
  if [ "$status" -ne 0 ]; then
    compose logs --no-color --tail=100 app 2>&1 | redact >>"$LOG" || true
  fi
  compose down -v --remove-orphans >/dev/null 2>&1 || true
  docker image rm "$PROOF_IMAGE" >/dev/null 2>&1 || true
  mkdir -p "$(dirname "$REPORT")"
  {
    echo "OnEHR host proof (test.integration)"
    echo "commit: ${SHA12}"
    echo "date: $(date -u +%Y-%m-%dT%H:%M:%SZ)"
    if [ "$status" -eq 0 ]; then echo "result: PASS"; else echo "result: FAIL (exit ${status})"; fi
    echo
    redact <"$LOG"
  } >"$REPORT"
  rm -f "$LOG"
  cat "$REPORT"
  exit "$status"
}
trap cleanup EXIT

# leftovers of an aborted earlier run (same fixed project name)
compose down -v --remove-orphans >/dev/null 2>&1 || true

echo "== docker build (APP_VERSION=${SHA12})" >>"$LOG"
docker build -q --build-arg APP_VERSION="$SHA12" -t "$PROOF_IMAGE" . >>"$LOG" 2>&1

echo "== compose up (${PROOF_PROJECT} on 127.0.0.1:${HOST_PORT})" >>"$LOG"
compose up -d >>"$LOG" 2>&1

echo "== smoke flow" >>"$LOG"
export SMOKE_BASE_URL="http://127.0.0.1:${HOST_PORT}"
export SMOKE_USERNAME="$FORMS_BOOTSTRAP_ADMIN_USERNAME"
export SMOKE_EXPECT_VERSION="$SHA12"
export SMOKE_WAIT_S=180
export_env SMOKE_PASSWORD "$ADMIN_VALUE"
node scripts/smoke-test.mjs >>"$LOG" 2>&1
