#!/bin/sh
set -eu

# Ask BDS to save and close its world before deleting the disposable container.
# The world itself is safe in the bind-mounted runtime/bedrock directory.
container exec mc-wizard-bedrock sh -c '
  for p in /proc/[0-9]*; do
    cmd=$(tr "\000" " " < "$p/cmdline" 2>/dev/null) || continue
    case "$cmd" in
      ./bedrock_server-*) printf "%s\n" "$1" > "$p/fd/0"; exit $? ;;
    esac
  done
  echo "ERROR: Bedrock process not found" >&2
  exit 2
' mc-wizard stop
sleep 5
container delete --force mc-wizard-bedrock
