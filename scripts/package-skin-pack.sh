#!/bin/sh
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
source_dir="$root/bedrock/skin_packs/mc_wizard"
output="$root/dist/mc-wizard-skin.mcpack"

mkdir -p "$root/dist"
cd "$source_dir"
zip -q -r -FS "$output" .
printf '%s\n' "$output"
