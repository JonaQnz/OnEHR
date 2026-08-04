#!/bin/sh
set -eu

base_url="http://debug-ehrbase:8080/ehrbase/rest/openehr/v1"
until curl --silent --fail "$base_url/definition/template/adl1.4" >/dev/null; do
  echo "Waiting for debug EHRbase..."
  sleep 3
done

found=false
for template in /templates/*.opt /templates/*.OPT; do
  [ -f "$template" ] || continue
  found=true
  echo "Importing $(basename "$template")"
  curl --silent --show-error --fail-with-body \
    --user ehrbase-admin:EvenMoreSecretPassword \
    --header "Content-Type: application/xml" \
    --data-binary "@$template" \
    "$base_url/definition/template/adl1.4" || echo "Template already exists or was rejected: $(basename "$template")"
done

[ "$found" = true ] || echo "No .opt templates found; debug EHRbase is ready for templates."
