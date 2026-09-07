#!/usr/bin/env bash
# Stand-in for `docker` used by cleanup-whitelist-profile.test.mjs, driven
# through that script's DOCKER seam. It answers the four queries the script
# asks, records every admin-CLI call, and applies the state change the real
# panel would apply, so a test can assert on the ORDER of revoke and purge
# rather than only on the fact that both happened.
#
# State lives in $FAKE_DOCKER_STATE:
#   keys      one key per line: id|state|email|node|last-job-error
#   enum      "1" while route_profile still has ru_whitelist, else "0"
#   sticky    ids that never reach `revoked`, one per line (a stuck revoke)
#   calls.log every CLI invocation, in order
set -euo pipefail

STATE="$FAKE_DOCKER_STATE"
KEYS="$STATE/keys"

# Everything after `exec -T <service>` is the command the script wanted to run
# inside that container; the compose flags before it are noise here.
service=""
args=()
stage=0
for arg in "$@"; do
  # Plain ifs, not `[ … ] && …`: a failing test as the last command of a case
  # branch is a non-zero branch status, and `set -e` would end the script on it.
  if [ "$stage" = "0" ]; then
    if [ "$arg" = "exec" ]; then stage=1; fi
  elif [ "$stage" = "1" ]; then
    if [ "$arg" != "-T" ]; then
      service="$arg"
      stage=2
    fi
  else
    args+=("$arg")
  fi
done

if [ "$service" = "postgres" ]; then
  # psql -U … -d … -tAc "<sql>": the statement is the last argument.
  sql="${args[$(( ${#args[@]} - 1 ))]}"
  case "$sql" in
    *pg_enum*)
      cat "$STATE/enum"
      ;;
    *job_outbox*)
      awk -F'|' '$2 != "revoked" { print $1 "|" $2 "|" $5 }' "$KEYS"
      ;;
    *"join users u"*)
      awk -F'|' '{ print $1 "|" $2 "|" $3 "|" $4 }' "$KEYS"
      ;;
    *"count(*) from vpn_keys"*)
      awk -F'|' '$2 != "revoked"' "$KEYS" | wc -l | tr -d '[:space:]'
      ;;
    *"select id from vpn_keys"*)
      awk -F'|' '$2 == "revoked" { print $1 }' "$KEYS"
      ;;
    *)
      echo "fake-docker: unexpected query: $sql" >&2
      exit 1
      ;;
  esac
  exit 0
fi

if [ "$service" = "control-api" ]; then
  # `node -e <code>`: the script's JSON filter. Run it for real against the
  # local node, stdin included, so the test exercises the actual filter.
  if [ "${args[1]:-}" = "-e" ]; then
    node -e "${args[2]}"
    exit $?
  fi

  # `node apps/cli/dist/main.js <command> <id> [flags]`
  #
  # Drain stdin exactly as `docker compose exec -T` does. This is not cosmetic:
  # the real thing forwards the caller's stdin into the container, so a call
  # made INSIDE a `while read` loop eats the rest of that loop's input and the
  # loop ends after one iteration. A double that ignores stdin cannot see that
  # class of bug, and did not -- the ordering assertions below passed while the
  # script purged one key of three on a live panel.
  cat >/dev/null
  command="${args[2]:-}"
  id="${args[3]:-}"
  printf '%s %s\n' "$command" "$id" >>"$STATE/calls.log"
  case "$command" in
    key-revoke)
      if grep -qx "$id" "$STATE/sticky" 2>/dev/null; then
        # The revoke was accepted; the node just never confirms it.
        exit 0
      fi
      awk -F'|' -v target="$id" 'BEGIN { OFS = "|" }
        $1 == target { $2 = "revoked" }
        { print }' "$KEYS" >"$KEYS.tmp"
      mv "$KEYS.tmp" "$KEYS"
      ;;
    key-purge)
      awk -F'|' -v target="$id" '$1 != target' "$KEYS" >"$KEYS.tmp"
      mv "$KEYS.tmp" "$KEYS"
      ;;
    *)
      echo "fake-docker: unexpected CLI command: $command" >&2
      exit 1
      ;;
  esac
  exit 0
fi

echo "fake-docker: unexpected invocation: $*" >&2
exit 1
