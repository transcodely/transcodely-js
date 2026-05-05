#!/usr/bin/env bash
# sync-protos.sh - Copy public protos from ../api into proto/transcodely/v1.
# Skips internal services (admin, staff, worker) that should not be exposed
# to public SDK consumers.
set -euo pipefail

SDKS_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PROTOS="${API_PROTOS:-$SDKS_ROOT/../api/proto/transcodely/v1}"
DEST="$SDKS_ROOT/proto/transcodely/v1"

if [[ ! -d "$API_PROTOS" ]]; then
  echo "ERROR: cannot find api protos at $API_PROTOS"
  echo "Set API_PROTOS=/path/to/api/proto/transcodely/v1 if your layout is different."
  exit 1
fi

INTERNAL=(admin.proto staff.proto worker.proto)

is_internal() {
  local name="$1"
  for skip in "${INTERNAL[@]}"; do
    [[ "$name" == "$skip" ]] && return 0
  done
  return 1
}

mkdir -p "$DEST"
copied=0
skipped=0

for src in "$API_PROTOS"/*.proto; do
  name="$(basename "$src")"
  if is_internal "$name"; then
    echo "  skip   $name (internal)"
    skipped=$((skipped + 1))
    continue
  fi
  cp "$src" "$DEST/$name"
  echo "  copy   $name"
  copied=$((copied + 1))
done

echo
echo "Synced $copied public protos, skipped $skipped internal protos."
