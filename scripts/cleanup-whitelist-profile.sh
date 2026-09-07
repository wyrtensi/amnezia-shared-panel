#!/usr/bin/env bash
# One-time cleanup for the removed `ru_whitelist` route profile.
#
# Migration 0035 refuses to run while ANY vpn_keys row still names the profile
# -- in every state, `revoked` included -- because deleting a row whose peer is
# still on a node strands that peer forever: reconcile finds an orphan by the
# label the row holds, so with the row gone nothing on the panel knows the peer
# exists. This script is the sanctioned way to empty that set before an upgrade.
#
# It never writes to vpn_keys itself. Every change goes through the panel's own
# admin API, in the order that API enforces:
#
#   key-revoke  -> the worker deletes the peer from its node
#   (wait)      -> the key reaches `revoked`, which is what "the peer is gone"
#                  means; the API refuses to purge in any other state
#   key-purge   -> the row goes, and the guard's count drops
#
# It also strips a leftover `ru_whitelist` feed from the stack's `.env`. A
# worker from v0.9.37 on skips such an entry with a warning; v0.9.36 refused to
# start on it.
#
# Usage:
#   scripts/cleanup-whitelist-profile.sh                 # report only, changes nothing
#   scripts/cleanup-whitelist-profile.sh --confirm       # revoke, purge, clean .env
#   scripts/cleanup-whitelist-profile.sh --confirm --timeout=300
#
# Run it BEFORE upgrading the panel past v0.9.35, because the RUNNING panel is
# what performs the revoke, and a panel older than v0.9.35 cannot finish one
# whose peer is already gone: it turns the node's 404 into a failed job and
# leaves the key stuck in `revoking`. If this script reports keys stuck that
# way, upgrade to v0.9.35 first, let them drain, then run it again.
set -euo pipefail

SCRIPT_DIR="$(CDPATH='' cd -- "$(dirname -- "$0")" && pwd)"
. "$SCRIPT_DIR/lib/compose-dir.sh"

CONFIRM=0
TIMEOUT=180
for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=1 ;;
    --timeout=*) TIMEOUT="${arg#--timeout=}" ;;
    -h|--help)
      sed -n '2,32p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *)
      echo "Unknown argument: $arg" >&2
      exit 1
      ;;
  esac
done
case "$TIMEOUT" in
  ''|*[!0-9]*) echo "--timeout must be a whole number of seconds" >&2; exit 1 ;;
esac

# How long to wait between polls while the worker drains the revokes. Only the
# tests ever set this: five seconds is short against a job that takes a round
# trip to a node, and long enough not to hammer the database.
POLL_SECONDS="${POLL_SECONDS:-5}"

COMPOSE_DIR="$(require_compose_dir)" || exit 1
OVERRIDE=""
if [ -f "${COMPOSE_DIR}/compose.override.yaml" ]; then
  OVERRIDE="-f ${COMPOSE_DIR}/compose.override.yaml"
fi
# The docker binary is a variable so the tests can stand in for it without
# putting a shim on PATH -- a PATH entry is not portable to a Windows checkout,
# where these tests also run. Nothing but the tests ever sets it.
COMPOSE="${DOCKER:-docker} compose -f ${COMPOSE_DIR}/compose.yaml ${OVERRIDE}"
USER_NAME="${POSTGRES_USER:-amnezia_panel}"
DB_NAME="${POSTGRES_DB:-amnezia_panel}"
ENV_FILE="${COMPOSE_DIR}/.env"
PROFILE="ru_whitelist"

# Tuples only, unaligned: every query below is read into a shell variable.
psql_query() {
  $COMPOSE exec -T postgres psql -U "$USER_NAME" -d "$DB_NAME" -tAc "$1"
}

# The panel's own admin CLI, run where PANEL_IDENTITY_SECRET already lives, so
# this script never has to be handed a credential or store one.
#
# `</dev/null` is load-bearing, not tidiness. `docker compose exec -T` forwards
# the caller's stdin into the container, and every call below is made inside a
# `while read` loop reading a list of keys -- so without this the first call
# swallows the rest of that list and the loop ends after one iteration. On a
# live panel that purged one key of three and left the migration still blocked,
# with the script reporting success.
panel_cli() {
  $COMPOSE exec -T control-api node apps/cli/dist/main.js "$@" </dev/null
}

echo "==> [1/4] What still uses ${PROFILE}"

# Ask the enum, not the rows: after 0035 the value is gone, and a query casting
# to it would error rather than answer "nothing left".
ENUM_PRESENT="$(psql_query "select count(*) from pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname = 'route_profile' and e.enumlabel = '${PROFILE}'" | tr -d '[:space:]')"

KEY_ROWS=""
if [ "$ENUM_PRESENT" = "0" ]; then
  echo "The route_profile enum no longer has ${PROFILE}: migration 0035 has already run here, so no key can still use it."
else
  KEY_ROWS="$(psql_query "select k.id || '|' || k.state || '|' || u.email || '|' || coalesce(n.name, '-') from vpn_keys k join users u on u.id = k.owner_id left join nodes n on n.id = k.node_id where k.route_profile::text = '${PROFILE}' order by k.created_at")"
  if [ -z "$KEY_ROWS" ]; then
    echo "No vpn_keys row uses ${PROFILE}. Migration 0035's guard would pass as it is."
  else
    echo "These keys still use ${PROFILE} and block migration 0035:"
    printf '%s\n' "$KEY_ROWS" | while IFS='|' read -r id state email node; do
      [ -n "$id" ] || continue
      printf '  %s  %-12s %-28s node=%s\n' "$id" "$state" "$email" "$node"
    done
  fi
fi

echo "==> [2/4] What still names ${PROFILE} in ${ENV_FILE}"

ENV_FEED_LINES=0
ENV_POC_LINES=0
if [ -f "$ENV_FILE" ]; then
  ENV_FEED_LINES="$(grep -c "^RULE_FEEDS=.*${PROFILE}" "$ENV_FILE" || true)"
  ENV_POC_LINES="$(grep -c '^RU_WHITELIST_POC_APPROVED=' "$ENV_FILE" || true)"
  if [ "$ENV_FEED_LINES" = "0" ] && [ "$ENV_POC_LINES" = "0" ]; then
    echo "Nothing to clean: RULE_FEEDS does not name ${PROFILE}, and RU_WHITELIST_POC_APPROVED is not set."
  fi
  [ "$ENV_FEED_LINES" = "0" ] || echo "RULE_FEEDS still lists ${PROFILE}."
  [ "$ENV_POC_LINES" = "0" ] || echo "RU_WHITELIST_POC_APPROVED is still set (dead configuration since the profile was removed)."
else
  echo "No ${ENV_FILE} on this host; skipping the environment half."
fi

if [ "$CONFIRM" != "1" ]; then
  echo
  echo "Report only. Re-run with --confirm to revoke and purge the keys above and clean the environment."
  exit 0
fi

echo "==> [3/4] Revoking and purging"

if [ -z "$KEY_ROWS" ]; then
  echo "Nothing to revoke."
else
  # Revoke them all first and wait once: the jobs run concurrently on the
  # worker, so waiting per key would serialise the whole cleanup for no gain.
  printf '%s\n' "$KEY_ROWS" | while IFS='|' read -r id state _email _node; do
    [ -n "$id" ] || continue
    if [ "$state" = "revoked" ]; then
      echo "  ${id} is already revoked; nothing to ask its node for."
      continue
    fi
    echo "  revoking ${id} (was ${state})"
    panel_cli key-revoke "$id"
  done

  echo "  waiting up to ${TIMEOUT}s for the nodes to confirm"
  DEADLINE=$(( $(date +%s) + TIMEOUT ))
  while :; do
    PENDING="$(psql_query "select count(*) from vpn_keys where route_profile::text = '${PROFILE}' and state <> 'revoked'" | tr -d '[:space:]')"
    [ "$PENDING" = "0" ] && break
    [ "$(date +%s)" -ge "$DEADLINE" ] && break
    sleep "$POLL_SECONDS"
  done

  # Read the stragglers BEFORE purging, so the report below describes the same
  # set the purge loop deliberately skips.
  STUCK="$(psql_query "select k.id || '|' || k.state || '|' || coalesce((select left(coalesce(j.last_error, '-'), 60) from job_outbox j where j.payload->>'keyId' = k.id::text order by j.updated_at desc limit 1), '-') from vpn_keys k where k.route_profile::text = '${PROFILE}' and k.state <> 'revoked'")"

  # Purge only what a node confirmed. A key short of `revoked` keeps its row on
  # purpose: that row is the only thing that can still find its peer.
  psql_query "select id from vpn_keys where route_profile::text = '${PROFILE}' and state = 'revoked'" | while read -r id; do
    [ -n "$id" ] || continue
    echo "  purging ${id}"
    panel_cli key-purge "$id" --confirm
  done

  if [ -n "$STUCK" ]; then
    echo
    echo "!! These keys did not reach 'revoked', so their rows were left alone:" >&2
    printf '%s\n' "$STUCK" | while IFS='|' read -r id state err; do
      [ -n "$id" ] || continue
      printf '   %s  %-12s last job error: %s\n' "$id" "$state" "$err" >&2
    done
    echo "   A 404 from the node means the peer is already gone and this panel is too old to accept that: upgrade to v0.9.35 first, let the worker drain, then run this again." >&2
    exit 1
  fi
fi

echo "==> [4/4] Cleaning ${ENV_FILE}"

if [ ! -f "$ENV_FILE" ]; then
  echo "No environment file to clean."
elif [ "$ENV_FEED_LINES" = "0" ] && [ "$ENV_POC_LINES" = "0" ]; then
  echo "Nothing to clean."
else
  if [ "$ENV_FEED_LINES" -gt 1 ]; then
    echo "!! ${ENV_FILE} has more than one RULE_FEEDS line naming ${PROFILE}; refusing to guess which is live. Fix it by hand." >&2
    exit 1
  fi

  FILTERED=""
  if [ "$ENV_FEED_LINES" = "1" ]; then
    RAW_FEEDS="$(grep '^RULE_FEEDS=' "$ENV_FILE" | head -n 1)"
    RAW_FEEDS="${RAW_FEEDS#RULE_FEEDS=}"
    # Filter the JSON with node rather than sed: the value is a JSON array, and
    # a regex editing one object out of it would depend on whatever spacing the
    # operator happened to use. Exit 3 = not the array we expected, 4 = removing
    # the entry would leave no feeds at all.
    set +e
    FILTERED="$(printf '%s' "$RAW_FEEDS" | $COMPOSE exec -T control-api node -e '
const raw = require("node:fs").readFileSync(0, "utf8");
let parsed;
try {
  parsed = JSON.parse(raw);
} catch {
  process.exit(3);
}
if (!Array.isArray(parsed)) process.exit(3);
const kept = parsed.filter((entry) => !entry || entry.profile !== "ru_whitelist");
if (kept.length === 0) process.exit(4);
process.stdout.write(JSON.stringify(kept));
')"
    FILTER_STATUS=$?
    set -e
    case "$FILTER_STATUS" in
      0) ;;
      3)
        echo "!! RULE_FEEDS in ${ENV_FILE} is not a JSON array; leaving it alone." >&2
        exit 1
        ;;
      4)
        echo "!! ${PROFILE} is the only profile in RULE_FEEDS, so removing it would leave no feeds at all." >&2
        echo "   That is a decision, not a cleanup: RULE_FEEDS=[] means 'fetch nothing', while deleting the variable hands the worker its built-in defaults. Pick one by hand." >&2
        exit 1
        ;;
      *)
        echo "!! Could not filter RULE_FEEDS (exit ${FILTER_STATUS}); leaving ${ENV_FILE} alone." >&2
        exit 1
        ;;
    esac
  fi

  STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
  BACKUP="${ENV_FILE}.bak-${STAMP}"
  cp -a "$ENV_FILE" "$BACKUP"
  echo "Backed up to ${BACKUP}"

  # cp -a first so the temporary file already carries the .env's mode and owner;
  # the redirect below truncates it without changing either.
  TMP="${ENV_FILE}.cleanup.$$"
  cp -a "$ENV_FILE" "$TMP"
  # ENVIRON rather than -v: awk interprets backslash escapes in a -v value, and
  # this one is operator-written JSON.
  NEW_FEEDS="$FILTERED" HAD_FEEDS="$ENV_FEED_LINES" awk '
    /^RU_WHITELIST_POC_APPROVED=/ { next }
    /^RULE_FEEDS=/ {
      if (ENVIRON["HAD_FEEDS"] == "1") { print "RULE_FEEDS=" ENVIRON["NEW_FEEDS"]; next }
    }
    { print }
  ' "$ENV_FILE" >"$TMP"
  mv "$TMP" "$ENV_FILE"
  echo "Cleaned ${ENV_FILE}. Recreate the panel services to pick it up (infra/prod/update.sh, or docker compose up -d)."
fi

echo
echo "Done. Re-run without --confirm to see the state you are leaving behind."
