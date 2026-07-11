#!/bin/sh
set -eu

ROOT=$(pwd -P)
DATA="$ROOT/runtime/bedrock"
LEVEL="$DATA/worlds/mc-wizard/level.dat"
IMAGE="docker.io/itzg/minecraft-bedrock-server@sha256:45c8f292b289659c0be469b2eaaebfc1fbfefdf5c060a0df5ed53fe9e2e7c563"
NAME="mc-wizard-bootstrap"

cleanup() {
  container stop --time 60 "$NAME" >/dev/null 2>&1 || true
  container delete "$NAME" >/dev/null 2>&1 || true
}

if ! command -v container >/dev/null 2>&1; then
  echo "Apple's container CLI is not installed." >&2
  exit 1
fi
if [ -e "$LEVEL" ]; then
  echo "Refusing to replace existing world: $LEVEL" >&2
  exit 1
fi
if container inspect "$NAME" >/dev/null 2>&1; then
  echo "Refusing to reuse existing container: $NAME" >&2
  exit 1
fi

mkdir -p "$DATA"
trap cleanup EXIT HUP INT TERM
container run --detach \
  --name "$NAME" \
  --platform linux/arm64 \
  --cpus 4 \
  --memory 6g \
  --volume "$DATA:/data" \
  --env EULA=TRUE \
  --env VERSION=1.26.33.2 \
  --env LEVEL_NAME=mc-wizard \
  --env GAMEMODE=creative \
  --env FORCE_GAMEMODE=true \
  --env DIFFICULTY=peaceful \
  --env ALLOW_CHEATS=true \
  --env ONLINE_MODE=true \
  --env ALLOW_LIST=false \
  --env USE_BOX64=true \
  "$IMAGE"

attempt=0
while [ "$attempt" -lt 180 ]; do
  if container logs "$NAME" 2>&1 | grep -q "Server started."; then
    break
  fi
  attempt=$((attempt + 1))
  sleep 2
done
if [ "$attempt" -ge 180 ]; then
  echo "BDS did not report Server started within six minutes; inspect: container logs $NAME" >&2
  exit 1
fi

container stop --time 60 "$NAME"
container delete "$NAME"
trap - EXIT HUP INT TERM
if [ ! -f "$LEVEL" ]; then
  echo "BDS stopped but did not create $LEVEL" >&2
  exit 1
fi
python3 "$ROOT/scripts/enable-beta-apis.py" "$LEVEL"
echo "Fresh mc-wizard world created with Beta APIs enabled. It has not been exposed on a network port."
