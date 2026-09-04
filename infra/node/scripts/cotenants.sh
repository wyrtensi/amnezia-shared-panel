#!/bin/sh
# Prove that a deploy did not disturb anybody else on this host.
#
# A node often shares a box with services that are not ours: a legacy AmneziaVPN
# desktop install, an Outline/shadowbox server, another tenant's tunnel. The
# rule "never touch them" is written down in docs/NODE-CONNECT.md, and until now
# nothing enforced it - a deploy that broke a co-tenant would finish reporting
# success, and the operator would learn about it from users.
#
# So the deploy takes a snapshot first and checks it afterwards. Two failure
# modes are covered, and the second is the one that hides:
#
#   1. the container is gone or stopped;
#   2. the container is still running and has lost its published ports, so it
#      looks perfectly healthy in `docker ps` while its traffic goes nowhere.
#
# A container carrying NO compose labels is a co-tenant, not ours. That is the
# important case: preflight's existing guard only refuses a name owned by a
# DIFFERENT compose project, and a desktop-client install has no labels at all,
# so it passes straight through a check written that way.
set -eu

PROJECT="${COMPOSE_PROJECT_NAME:-amnezia-node}"

usage() {
  printf 'Usage: cotenants.sh snapshot <file> | verify <file>\n' >&2
  exit 2
}

# name<TAB>running<TAB>ports, one line per running container that is not ours.
collect() {
  docker ps --format '{{.Names}}' 2>/dev/null | while IFS= read -r name; do
    [ -n "$name" ] || continue
    details="$(docker inspect \
      --format '{{index .Config.Labels "com.docker.compose.project"}}|{{.State.Running}}|{{json .NetworkSettings.Ports}}' \
      "$name" 2>/dev/null || true)"
    [ -n "$details" ] || continue
    project="${details%%|*}"
    rest="${details#*|}"
    running="${rest%%|*}"
    ports="${rest#*|}"
    [ "$project" != "$PROJECT" ] || continue
    printf '%s\t%s\t%s\n' "$name" "$running" "$ports"
  done
}

# The same three fields for one container, whether or not it is still running.
inspect_one() {
  docker inspect \
    --format '{{index .Config.Labels "com.docker.compose.project"}}|{{.State.Running}}|{{json .NetworkSettings.Ports}}' \
    "$1" 2>/dev/null || true
}

command="${1:-}"
file="${2:-}"
[ -n "$command" ] && [ -n "$file" ] || usage

case "$command" in
  snapshot)
    collect >"$file"
    ;;
  verify)
    # No snapshot means nothing was recorded to compare against. Treat it as a
    # failure rather than as a pass: silently succeeding here would make the
    # guard disappear the moment the snapshot step is skipped or misspelled.
    [ -f "$file" ] || {
      printf 'ERROR: no co-tenant snapshot at %s\n' "$file" >&2
      exit 1
    }
    failures=0
    while IFS="$(printf '\t')" read -r name was_running was_ports; do
      [ -n "$name" ] || continue
      details="$(inspect_one "$name")"
      if [ -z "$details" ]; then
        printf 'ERROR: co-tenant %s existed before this deploy and is gone now\n' "$name" >&2
        failures=$((failures + 1))
        continue
      fi
      rest="${details#*|}"
      running="${rest%%|*}"
      ports="${rest#*|}"
      if [ "$was_running" = "true" ] && [ "$running" != "true" ]; then
        printf 'ERROR: co-tenant %s is no longer running after this deploy\n' "$name" >&2
        failures=$((failures + 1))
        continue
      fi
      if [ "$ports" != "$was_ports" ]; then
        printf 'ERROR: co-tenant %s lost or changed its published ports: %s -> %s\n' \
          "$name" "$was_ports" "$ports" >&2
        failures=$((failures + 1))
      fi
    done <"$file"
    if [ "$failures" -gt 0 ]; then
      printf 'ERROR: this deploy disturbed %s container(s) that do not belong to it.\n' "$failures" >&2
      printf 'ERROR: restore them before doing anything else; do not re-run the deploy.\n' >&2
      exit 1
    fi
    ;;
  *)
    usage
    ;;
esac
