#!/bin/sh
set -eu

ROOT=$(pwd -P)
DATA="$ROOT/runtime/bedrock"
WORLD_NAME="mc-wizard"
WORLD="$DATA/worlds/$WORLD_NAME/level.dat"
IMAGE="docker.io/itzg/minecraft-bedrock-server@sha256:45c8f292b289659c0be469b2eaaebfc1fbfefdf5c060a0df5ed53fe9e2e7c563"
RUN_ID=$(openssl rand -hex 12)
NAME="mc-wizard-e2e-$RUN_ID"
CREATED=0
GATED=0
LOG_PID=
FIFO="$DATA/.e2e-$RUN_ID.fifo"

if [ ! -f "$ROOT/package.json" ] || [ ! -f "$WORLD" ]; then
  echo "Run from the MC Wizard repository root after npm run bootstrap:bds." >&2
  exit 1
fi
if ! command -v container >/dev/null 2>&1; then
  echo "Apple's container CLI is not installed." >&2
  exit 1
fi
if container inspect mc-wizard-bedrock >/dev/null 2>&1; then
  echo "Refusing to share the world with mc-wizard-bedrock; stop and delete it first." >&2
  exit 1
fi
if container list --all 2>/dev/null | grep -q 'mc-wizard-e2e-'; then
  echo "Refusing to start while a prior mc-wizard-e2e container remains." >&2
  exit 1
fi

BRAIN_ORIGIN=$(node --env-file-if-exists=.env -e '
  const host = process.env.HOST;
  const port = process.env.PORT || "3000";
  if (!host) process.exit(1);
  process.stdout.write("http://" + host + ":" + port);
')
BRAIN_URL="$BRAIN_ORIGIN/v1/ask"
curl --fail --silent --show-error "$BRAIN_ORIGIN/health" >/dev/null

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$LOG_PID" ]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
    LOG_PID=
  fi
  rm -f "$FIFO"
  if [ "$CREATED" -eq 1 ]; then
    container stop --time 10 "$NAME" >/dev/null 2>&1 || status=1
    container delete "$NAME" >/dev/null 2>&1 || true
  fi
  if [ "$GATED" -eq 1 ]; then
    if ! MC_WIZARD_E2E=0 MC_WIZARD_E2E_RUN= npm run install:pack -- \
      "$DATA" "$WORLD_NAME" "$BRAIN_URL" >/dev/null; then
      echo "Could not disable the E2E gate after the run." >&2
      status=1
    fi
  fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM

GATED=1
MC_WIZARD_E2E=1 MC_WIZARD_E2E_RUN="$RUN_ID" npm run install:pack -- \
  "$DATA" "$WORLD_NAME" "$BRAIN_URL"

CREATED=1
container run --detach --rm \
  --name "$NAME" \
  --platform linux/amd64 \
  --cpus 4 \
  --memory 6g \
  --volume "$DATA:/data" \
  --env EULA=TRUE \
  --env VERSION=1.26.33.2 \
  --env SERVER_NAME="MC Wizard E2E" \
  --env LEVEL_NAME="$WORLD_NAME" \
  --env GAMEMODE=creative \
  --env FORCE_GAMEMODE=true \
  --env DIFFICULTY=peaceful \
  --env ALLOW_CHEATS=true \
  --env ONLINE_MODE=true \
  --env ALLOW_LIST=false \
  --env ENABLE_LAN_VISIBILITY=false \
  --env CONTENT_LOG_FILE_ENABLED=true \
  --env CONTENT_LOG_CONSOLE_OUTPUT_ENABLED=true \
  "$IMAGE"

mkfifo "$FIFO"
(
  while container inspect "$NAME" >/dev/null 2>&1; do
    container logs -n 80 "$NAME" 2>&1 || true
    sleep 2
  done
) >"$FIFO" &
LOG_PID=$!
result=0
MC_WIZARD_E2E_RUN="$RUN_ID" E2E_TIMEOUT_MS=600000 E2E_LOG_FILE="$DATA/e2e-last.log" \
  node scripts/wait-e2e.mjs <"$FIFO" || result=$?
kill "$LOG_PID" >/dev/null 2>&1 || true
LOG_PID=
exit "$result"
