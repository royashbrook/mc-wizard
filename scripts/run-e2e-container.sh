#!/bin/sh
set -eu

ROOT=$(pwd -P)
WORLD_NAME="mc-wizard-e2e"
IMAGE="docker.io/itzg/minecraft-bedrock-server@sha256:45c8f292b289659c0be469b2eaaebfc1fbfefdf5c060a0df5ed53fe9e2e7c563"
RUN_ID=$(openssl rand -hex 12)
E2E_SCOPE=${MC_WIZARD_E2E_SCOPE:-full}
if [ "$E2E_SCOPE" = "local-travel" ]; then
  WORLD_TYPE=DEFAULT
  WORLD_SEED=8675309
else
  WORLD_TYPE=FLAT
  WORLD_SEED=8675309
fi
DATA="$ROOT/runtime/e2e/$RUN_ID"
WORLD="$DATA/worlds/$WORLD_NAME/level.dat"
BOOT_NAME="mc-wizard-e2e-bootstrap-$RUN_ID"
NAME="mc-wizard-e2e-$RUN_ID"
FIFO="$DATA/log.fifo"
BOOT_CREATED=0
CREATED=0
LOG_PID=
BRAIN_PID=

if [ ! -f "$ROOT/package.json" ]; then
  echo "Run from the MC Wizard repository root." >&2
  exit 1
fi
if [ "$E2E_SCOPE" != "full" ] && [ "$E2E_SCOPE" != "machines" ] && [ "$E2E_SCOPE" != "commands" ] && [ "$E2E_SCOPE" != "arbitrary" ] && [ "$E2E_SCOPE" != "portal" ] && [ "$E2E_SCOPE" != "travel-rollback" ] && [ "$E2E_SCOPE" != "local-travel" ] && [ "$E2E_SCOPE" != "city" ] && [ "$E2E_SCOPE" != "child" ] && [ "$E2E_SCOPE" != "refinement" ] && [ "$E2E_SCOPE" != "feedback" ] && [ "$E2E_SCOPE" != "farms" ] && [ "$E2E_SCOPE" != "kelp" ] && [ "$E2E_SCOPE" != "delivery" ]; then
  echo "MC_WIZARD_E2E_SCOPE must be full, machines, commands, arbitrary, portal, travel-rollback, local-travel, city, child, refinement, feedback, farms, kelp, or delivery." >&2
  exit 1
fi
if ! command -v container >/dev/null 2>&1; then
  echo "Apple's container CLI is not installed." >&2
  exit 1
fi
if container list --all 2>/dev/null | grep -q 'mc-wizard-e2e-'; then
  echo "Refusing to start while a prior E2E container remains." >&2
  exit 1
fi

cleanup() {
  status=$?
  trap - EXIT HUP INT TERM
  if [ -n "$LOG_PID" ]; then
    kill "$LOG_PID" >/dev/null 2>&1 || true
  fi
  if [ -n "$BRAIN_PID" ]; then
    kill "$BRAIN_PID" >/dev/null 2>&1 || true
    wait "$BRAIN_PID" >/dev/null 2>&1 || true
  fi
  if [ "$CREATED" -eq 1 ]; then
    container stop --time 10 "$NAME" >/dev/null 2>&1 || true
    container delete "$NAME" >/dev/null 2>&1 || true
  fi
  if [ "$BOOT_CREATED" -eq 1 ]; then
    container stop --time 10 "$BOOT_NAME" >/dev/null 2>&1 || true
    container delete "$BOOT_NAME" >/dev/null 2>&1 || true
  fi
  rm -f "$FIFO"
  if [ "$status" -eq 0 ]; then
    rm -rf "$DATA"
  else
    echo "Failed E2E world retained at $DATA" >&2
  fi
  exit "$status"
}
trap cleanup EXIT HUP INT TERM

mkdir -p "$DATA"
BRAIN_HOST=$(node --env-file-if-exists=.env -e '
  if (!process.env.HOST) process.exit(1);
  process.stdout.write(process.env.HOST);
')
BRAIN_PORT=${MC_WIZARD_E2E_BRAIN_PORT:-3099}
BRAIN_ORIGIN="http://$BRAIN_HOST:$BRAIN_PORT"
BRAIN_URL="$BRAIN_ORIGIN/v1/ask"
if curl --fail --silent "$BRAIN_ORIGIN/health" >/dev/null 2>&1; then
  echo "Refusing to reuse an existing service on the isolated E2E brain port $BRAIN_PORT." >&2
  exit 1
fi
HOST="$BRAIN_HOST" \
PORT="$BRAIN_PORT" \
BEDROCK_CONTAINER_NAME="$NAME" \
REQUEST_COOLDOWN_MS=0 \
SESSION_FILE="$DATA/brain-sessions.json" \
LEARNED_RECIPES_FILE="$DATA/learned-recipes.json" \
PLAYER_PREFERENCES_FILE="$DATA/player-preferences.json" \
INTERACTION_LOG_FILE="$DATA/interactions.jsonl" \
RUNTIME_SETTINGS_FILE="$DATA/settings.json" \
node --env-file-if-exists=.env src/server.mjs >"$DATA/brain.log" 2>&1 &
BRAIN_PID=$!
attempt=0
while [ "$attempt" -lt 120 ]; do
  if curl --fail --silent "$BRAIN_ORIGIN/health" >/dev/null 2>&1; then break; fi
  attempt=$((attempt + 1))
  sleep 1
done
if [ "$attempt" -ge 120 ]; then
  echo "Isolated E2E brain did not start within two minutes." >&2
  exit 1
fi

BOOT_CREATED=1
container run --detach \
  --name "$BOOT_NAME" \
  --platform linux/amd64 \
  --cpus 4 \
  --memory 6g \
  --volume "$DATA:/data" \
  --env EULA=TRUE \
  --env VERSION=1.26.33.2 \
  --env LEVEL_NAME="$WORLD_NAME" \
  --env LEVEL_TYPE="$WORLD_TYPE" \
  --env LEVEL_SEED="$WORLD_SEED" \
  --env GAMEMODE=creative \
  --env FORCE_GAMEMODE=true \
  --env DIFFICULTY=peaceful \
  --env ALLOW_CHEATS=true \
  --env ONLINE_MODE=false \
  --env ALLOW_LIST=false \
  --env ENABLE_LAN_VISIBILITY=false \
  "$IMAGE" >/dev/null

attempt=0
while [ "$attempt" -lt 180 ]; do
  if container logs "$BOOT_NAME" 2>&1 | grep -q "Server started."; then break; fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$attempt" -ge 180 ]; then
  echo "Bootstrap BDS did not start within six minutes." >&2
  exit 1
fi
container stop --time 60 "$BOOT_NAME" >/dev/null
container delete "$BOOT_NAME" >/dev/null
BOOT_CREATED=0
python3 "$ROOT/scripts/enable-beta-apis.py" "$WORLD" >/dev/null

MC_WIZARD_E2E=1 MC_WIZARD_E2E_RUN="$RUN_ID" MC_WIZARD_E2E_SCOPE="$E2E_SCOPE" npm run install:pack -- \
  "$DATA" "$WORLD_NAME" "$BRAIN_URL" >/dev/null

CREATED=1
container run --detach \
  --name "$NAME" \
  --platform linux/amd64 \
  --cpus 4 \
  --memory 6g \
  --volume "$DATA:/data" \
  --env EULA=TRUE \
  --env VERSION=1.26.33.2 \
  --env SERVER_NAME="MC Wizard E2E" \
  --env LEVEL_NAME="$WORLD_NAME" \
  --env LEVEL_TYPE="$WORLD_TYPE" \
  --env LEVEL_SEED="$WORLD_SEED" \
  --env GAMEMODE=creative \
  --env FORCE_GAMEMODE=true \
  --env DIFFICULTY=peaceful \
  --env ALLOW_CHEATS=true \
  --env ONLINE_MODE=false \
  --env ALLOW_LIST=false \
  --env ENABLE_LAN_VISIBILITY=false \
  --env CONTENT_LOG_FILE_ENABLED=true \
  --env CONTENT_LOG_CONSOLE_OUTPUT_ENABLED=true \
  "$IMAGE" >/dev/null

mkfifo "$FIFO"
(
  while container inspect "$NAME" >/dev/null 2>&1; do
    container logs -n 100 "$NAME" 2>&1 || true
    sleep 2
  done
) >"$FIFO" &
LOG_PID=$!
result=0
if [ "$E2E_SCOPE" = "arbitrary" ] || [ "$E2E_SCOPE" = "refinement" ] || [ "$E2E_SCOPE" = "feedback" ] || [ "$E2E_SCOPE" = "travel-rollback" ] || [ "$E2E_SCOPE" = "local-travel" ] || [ "$E2E_SCOPE" = "city" ]; then E2E_TIMEOUT_MS=300000
elif [ "$E2E_SCOPE" = "farms" ]; then E2E_TIMEOUT_MS=600000
else E2E_TIMEOUT_MS=1800000
fi
MC_WIZARD_E2E_RUN="$RUN_ID" E2E_TIMEOUT_MS="$E2E_TIMEOUT_MS" E2E_LOG_FILE="$ROOT/runtime/e2e-last.log" \
  node scripts/wait-e2e.mjs <"$FIFO" || result=$?
kill "$LOG_PID" >/dev/null 2>&1 || true
LOG_PID=
exit "$result"
