#!/bin/sh
set -eu

ROOT=$(pwd -P)
DATA="$ROOT/runtime/bedrock"
WORLD="$DATA/worlds/mc-wizard/level.dat"
IMAGE="docker.io/itzg/minecraft-bedrock-server@sha256:45c8f292b289659c0be469b2eaaebfc1fbfefdf5c060a0df5ed53fe9e2e7c563"

if [ ! -f "$ROOT/package.json" ]; then
  echo "Run this command from the MC Wizard repository root." >&2
  exit 1
fi
if ! command -v container >/dev/null 2>&1; then
  echo "Apple's container CLI is not installed. Follow README.md's signed-installer steps first." >&2
  exit 1
fi
if [ ! -f "$WORLD" ]; then
  echo "Missing $WORLD" >&2
  echo "Export a Bedrock world with Beta APIs enabled and put it there before starting BDS." >&2
  exit 1
fi
LAN_IP=${MC_WIZARD_LAN_IP:-}
case "$LAN_IP" in
  *[!0-9.]*|"")
    echo "MC_WIZARD_LAN_IP must be this Mac's private LAN IPv4 address." >&2
    exit 1
    ;;
esac
case "$LAN_IP" in
  10.*|192.168.*|172.1[6-9].*|172.2[0-9].*|172.3[01].*) ;;
  *)
    echo "MC_WIZARD_LAN_IP must be an RFC1918 private address." >&2
    exit 1
    ;;
esac
if ! ifconfig | awk -v ip="$LAN_IP" '$1 == "inet" && $2 == ip { found = 1 } END { exit !found }'; then
  echo "MC_WIZARD_LAN_IP is not assigned to this Mac." >&2
  exit 1
fi
ALLOW_LIST_USERS=${MC_WIZARD_ALLOW_LIST_USERS:-}
ALLOW_LIST=true
if [ "${MC_WIZARD_OPEN_LAN:-}" = "1" ]; then
  ALLOW_LIST=false
  ALLOW_LIST_USERS=
  echo "Starting in explicitly requested open-LAN mode; any authenticated player on this private network can join." >&2
elif ! printf '%s\n' "$ALLOW_LIST_USERS" \
  | grep -Eq '^([^,:]+(,[^,:]+)*|[^,:]+:[0-9]{16,}(,[^,:]+:[0-9]{16,})*)$'; then
  echo "Set MC_WIZARD_ALLOW_LIST_USERS to either exact gamertags or gamertag:numeric-XUID pairs." >&2
  echo "Do not mix the two forms in one list." >&2
  echo "Or set MC_WIZARD_OPEN_LAN=1 to deliberately allow anyone on the private LAN." >&2
  exit 1
fi

mkdir -p "$DATA"
container run --detach \
  --name mc-wizard-bedrock \
  --platform linux/amd64 \
  --cpus 4 \
  --memory 6g \
  --publish "${LAN_IP}:19132:19132/udp" \
  --volume "$DATA:/data" \
  --volume "$ROOT/bedrock:/packs/mc-wizard:ro" \
  --env EULA=TRUE \
  --env VERSION=1.26.33.2 \
  --env SERVER_NAME="MC Wizard" \
  --env LEVEL_NAME=mc-wizard \
  --env GAMEMODE=creative \
  --env FORCE_GAMEMODE=true \
  --env DIFFICULTY=peaceful \
  --env ALLOW_CHEATS=true \
  --env ONLINE_MODE=true \
  --env "ALLOW_LIST=$ALLOW_LIST" \
  --env "ALLOW_LIST_USERS=$ALLOW_LIST_USERS" \
  --env ENABLE_LAN_VISIBILITY=true \
  --env SERVER_PORT=19132 \
  --env CONTENT_LOG_FILE_ENABLED=true \
  --env CONTENT_LOG_CONSOLE_OUTPUT_ENABLED=true \
  --env MC_PACK=/packs/mc-wizard \
  --env FORCE_PACK_COPY=true \
  --env FORCE_WORLD_COPY=false \
  "$IMAGE"

echo "BDS launch requested as mc-wizard-bedrock. Follow startup with: npm run container:logs"
