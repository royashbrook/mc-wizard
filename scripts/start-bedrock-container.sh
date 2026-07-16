#!/bin/sh
set -eu

ROOT=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
cd "$ROOT"

npm run install:pack -- runtime/bedrock mc-wizard
node scripts/initialize-bedrock-properties.mjs
container start mc-wizard-bedrock
