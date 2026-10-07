#!/bin/sh
set -eu
CUSA_INSTALL_DIR=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v node >/dev/null 2>&1; then
  echo 'Node.js not in PATH. Use Plesk Run Script: install:plesk, or select the Plesk Node.js executable.' >&2
  exit 1
fi
exec node "$CUSA_INSTALL_DIR/install.mjs" "$@"
