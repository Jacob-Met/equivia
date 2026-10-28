#!/bin/bash
set -eu
PACKAGE_DIR="$(CDPATH= cd -- "$(/usr/bin/dirname -- "$0")" && pwd -P)"
exec /usr/bin/env -i \
  PATH=/usr/bin:/bin:/usr/sbin:/sbin \
  LANG=en_US.UTF-8 \
  "$PACKAGE_DIR/runtime/bin/node" \
  "$PACKAGE_DIR/launcher.mjs" "$@"
