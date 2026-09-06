# Shared by scripts/backup-db.sh, scripts/restore-db.sh and scripts/deploy.sh:
# decide which compose project a manual invocation should talk to when the
# caller did not set COMPOSE_DIR.
#
# `compose.yaml` is committed to git and exists in BOTH infra/prod and
# infra/dev on every checkout, so its presence can't tell a real deployment
# apart from a bare clone -- it can only catch a typo in an already-chosen
# directory (see require_compose_dir below). `.env` can tell them apart:
# /.gitignore ignores ".env" and ".env.*" (with an explicit "!.env.example"
# carve-out), so infra/prod/.env and infra/dev/.env exist only once a human
# has copied that directory's .env.example and filled it in for a real stack.
# That is exactly the signal we need -- present on a host actually configured
# for that stack, absent on a plain checkout -- and it is what every one of
# these compose files already requires at runtime (each declares `env_file:
# - .env`), so a host that lacks it can't be running that stack anyway.
#
# This file is sourced, not executed; it only defines functions.

# Prints the resolved directory on stdout and returns 0 on success. On
# failure it prints nothing to stdout, explains on stderr what it looked for
# and how to override, and returns 1 -- callers must not fall back to a
# guess.
resolve_compose_dir() {
  # An explicit override always wins, unchanged, and is not second-guessed
  # here (require_compose_dir still checks it names a real compose.yaml).
  if [ -n "${COMPOSE_DIR:-}" ]; then
    printf '%s\n' "$COMPOSE_DIR"
    return 0
  fi

  local prod_marker="infra/prod/.env"
  local dev_marker="infra/dev/.env"
  local have_prod=0
  local have_dev=0
  [ -f "$prod_marker" ] && have_prod=1
  [ -f "$dev_marker" ] && have_dev=1

  if [ "$have_prod" = 1 ] && [ "$have_dev" = 0 ]; then
    printf '%s\n' "infra/prod"
    return 0
  fi
  if [ "$have_dev" = 1 ] && [ "$have_prod" = 0 ]; then
    printf '%s\n' "infra/dev"
    return 0
  fi

  if [ "$have_prod" = 1 ] && [ "$have_dev" = 1 ]; then
    echo "compose-dir: both ${prod_marker} and ${dev_marker} exist, so this host looks configured for both stacks; refusing to guess. Set COMPOSE_DIR=infra/prod or COMPOSE_DIR=infra/dev explicitly." >&2
  else
    echo "compose-dir: found neither ${prod_marker} nor ${dev_marker}, so this doesn't look like a configured deployment. Set COMPOSE_DIR explicitly (e.g. COMPOSE_DIR=infra/prod), or create that stack's .env from its .env.example." >&2
  fi
  return 1
}

# Resolve, confirm the pick actually has a compose.yaml, announce it on
# stderr, and print the directory alone on stdout for capture, e.g.:
#   COMPOSE_DIR="$(require_compose_dir)" || exit 1
# Meant to run at script top level under `set -euo pipefail` -- the `exit 1`
# calls below end the subshell that command substitution runs in, which is
# why callers must still check the substitution's own exit status.
require_compose_dir() {
  local dir
  dir="$(resolve_compose_dir)" || exit 1
  if [ ! -f "${dir}/compose.yaml" ]; then
    echo "compose-dir: ${dir}/compose.yaml not found. Set COMPOSE_DIR to the directory holding the compose.yaml for the stack you mean to use." >&2
    exit 1
  fi
  echo "Using COMPOSE_DIR=${dir}" >&2
  printf '%s\n' "$dir"
}
