#!/bin/sh
set -eu

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
# shellcheck source=common.sh
. "$SCRIPT_DIR/common.sh"

acquire_lock
ensure_layout

if archive="$(create_backup 1)"; then
  info "Backup created: $archive"
else
  status="$?"
  [ "$status" -ne 2 ] || fail "Neither AWG2 nor AWG3 state is initialized; there is nothing to back up"
  fail "backup failed"
fi

release_lock
