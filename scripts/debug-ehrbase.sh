#!/usr/bin/env sh
set -eu

case "${1:-}" in
  on) docker compose -f docker-compose.yml -f docker-compose.debug-ehrbase.yml --profile debug-ehrbase up -d ;;
  off) docker compose -f docker-compose.yml -f docker-compose.debug-ehrbase.yml --profile debug-ehrbase down ;;
  reset) docker compose -f docker-compose.yml -f docker-compose.debug-ehrbase.yml --profile debug-ehrbase down -v ;;
  import) docker compose -f docker-compose.yml -f docker-compose.debug-ehrbase.yml --profile debug-ehrbase run --rm debug-ehrbase-templates ;;
  *) echo "Usage: $0 {on|off|import|reset}"; exit 64 ;;
esac
