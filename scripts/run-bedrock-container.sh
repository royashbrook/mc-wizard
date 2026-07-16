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
if [ -z "${MC_WIZARD_LAN_IP:-}" ] && [ -f "$ROOT/.env" ]; then
  MC_WIZARD_LAN_IP=$(awk -F= '$1 == "MC_WIZARD_LAN_IP" { print $2; exit }' "$ROOT/.env")
  export MC_WIZARD_LAN_IP
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
echo "Starting in trusted open-LAN mode; any authenticated player on this private network can join as an operator." >&2

mkdir -p "$DATA"
node scripts/initialize-bedrock-properties.mjs
npm run install:pack -- "$DATA" mc-wizard
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
  --env LEVEL_NAME=mc-wizard \
  --env MC_PACK=/packs/mc-wizard \
  --env FORCE_PACK_COPY=true \
  --env FORCE_WORLD_COPY=false \
  "$IMAGE"

echo "BDS launch requested as mc-wizard-bedrock. Follow startup with: npm run container:logs"
