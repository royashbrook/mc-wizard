#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

if container exec mc-wizard-bedrock true >/dev/null 2>&1; then
  sh scripts/stop-bedrock-container.sh
else
  container delete --force mc-wizard-bedrock 2>/dev/null || true
fi
sh scripts/run-bedrock-container.sh
