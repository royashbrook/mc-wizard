#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

container delete mc-wizard-bedrock
sh scripts/run-bedrock-container.sh
