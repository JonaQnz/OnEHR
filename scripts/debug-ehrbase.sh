#!/usr/bin/env sh
set -eu

compose() { docker compose -f docker-compose.yml -f docker-compose.ehrbase-test.yml -f docker-compose.debug-ehrbase.yml "$@"; }

case "${1:-}" in
  on) compose up -d ;;
  off) compose down ;;
  reset) compose down -v ;;
  import) compose run --rm debug-ehrbase-templates ;;
  *) echo "Usage: $0 {on|off|import|reset}"; exit 64 ;;
esac
