#!/usr/bin/env bash
# Ensure this host has 2 GiB of swap, persisted across reboots.
#
# Every server in this project - panel or node - gets a 2 GiB /swapfile and
# vm.swappiness=10, regardless of how much RAM it has (docs/SMALL-HOSTS.md §1).
# add-node.sh streams this script to a new node as step 2/8; on a panel host it
# is the one-liner documented in docs/INSTALL.md §2. Nothing is installed on the
# host: the script arrives on stdin and leaves no copy behind.
#
# Usage:
#   ensure-swap.sh --check [--min-free-mib <n>]   report only, change nothing
#   ensure-swap.sh --apply [--min-free-mib <n>]   create or grow the swapfile
#
# Exit codes:
#   0   nothing to do (--check) / the host now has 2 GiB (--apply)
#   10  --check only: a change is needed and is safe to make
#   2   refused (the host cannot get 2 GiB safely), or bad usage
#
# --min-free-mib is how much free disk must remain once the swapfile exists.
# The default 3072 is the node's own deploy gate
# (infra/node/scripts/preflight.sh); the floor is 1024.
set -euo pipefail

# Every path is a seam so the tests can drive the real script against fixtures.
SWAPFILE="${ENSURE_SWAP_SWAPFILE:-/swapfile}"
MEMINFO="${ENSURE_SWAP_MEMINFO:-/proc/meminfo}"
SWAPS="${ENSURE_SWAP_SWAPS:-/proc/swaps}"
FSTAB="${ENSURE_SWAP_FSTAB:-/etc/fstab}"
SYSCTL_CONF="${ENSURE_SWAP_SYSCTL_CONF:-/etc/sysctl.d/99-swappiness.conf}"

TARGET_KB=2097152        # 2 GiB
ENOUGH_KB=2093056        # 2 GiB - 4 MiB: mkswap keeps a header page, so an
                         # exact compare would rebuild a correct swapfile forever
SWAPOFF_MARGIN_KB=131072 # headroom for the pages swapoff must fault back in

MODE=""
MIN_FREE_MIB=3072

die() { printf 'ensure-swap: %s\n' "$*" >&2; exit 2; }

# Prints the header comment and stops at the first line that is not one.
usage() {
  awk 'NR > 1 { if ($0 !~ /^#/) exit; sub(/^# ?/, ""); print }' "${BASH_SOURCE[0]}"
  exit 0
}

while [ $# -gt 0 ]; do
  case "$1" in
    --check) MODE=check; shift ;;
    --apply) MODE=apply; shift ;;
    --min-free-mib) MIN_FREE_MIB="${2:?--min-free-mib needs a value}"; shift 2 ;;
    -h|--help) usage ;;
    *) die "unknown argument: $1 (try --help)" ;;
  esac
done

[ -n "$MODE" ] || die "one of --check or --apply is required"
case "$MIN_FREE_MIB" in
  ''|*[!0-9]*) die "--min-free-mib must be a whole number of MiB" ;;
esac
[ "$MIN_FREE_MIB" -ge 1024 ] || die "--min-free-mib below 1024 leaves too little room for images and logs"
RESERVE_KB=$(( MIN_FREE_MIB * 1024 ))

meminfo_kb() {
  awk -v key="$1:" '$1 == key { print $2; found = 1 } END { if (!found) print 0 }' "$MEMINFO"
}

swap_total_kb="$(meminfo_kb SwapTotal)"
swap_free_kb="$(meminfo_kb SwapFree)"
mem_available_kb="$(meminfo_kb MemAvailable)"

file_kb=0
[ -f "$SWAPFILE" ] && file_kb=$(( $(stat -c %s "$SWAPFILE") / 1024 ))

swapfile_active=0
grep -q "^${SWAPFILE} " "$SWAPS" 2>/dev/null && swapfile_active=1

if [ -n "${ENSURE_SWAP_FREE_KB:-}" ]; then
  free_kb="$ENSURE_SWAP_FREE_KB"
else
  free_kb="$(df -Pk "$(dirname "$SWAPFILE")" | awk 'NR == 2 { print $4 }')"
fi

if [ -n "${ENSURE_SWAP_SWAPPINESS:-}" ]; then
  swappiness="$ENSURE_SWAP_SWAPPINESS"
else
  swappiness="$(sysctl -n vm.swappiness)"
fi

fstab_has_entry=0
grep -qE "^[[:space:]]*${SWAPFILE}[[:space:]]" "$FSTAB" 2>/dev/null && fstab_has_entry=1

# An fstab entry is only wanted for a /swapfile that is (or is about to be) in
# use: a host swapping to a partition must not get an entry for a file that
# does not exist. swappiness is wanted everywhere.
persist_needed=0
[ "$swapfile_active" = 1 ] && [ "$fstab_has_entry" = 0 ] && persist_needed=1
[ "$swappiness" = 10 ] || persist_needed=1

in_use_kb=$(( swap_total_kb - swap_free_kb ))
after_kb=$(( free_kb + file_kb - TARGET_KB ))

if [ "$swap_total_kb" -ge "$ENOUGH_KB" ]; then
  if [ "$persist_needed" = 1 ]; then state=persist; else state=ok; fi
elif [ "$after_kb" -lt "$RESERVE_KB" ]; then
  state=refuse-disk
elif [ "$swapfile_active" = 1 ] && [ $(( in_use_kb + SWAPOFF_MARGIN_KB )) -gt "$mem_available_kb" ]; then
  # in_use_kb counts every swap device, so a host with a second one is refused
  # conservatively. Being wrong in this direction costs a manual run; being
  # wrong the other way strands the host with no swap at all.
  state=refuse-ram
elif [ "$file_kb" -gt 0 ]; then
  state=recreate
else
  state=create
fi

mib() { printf '%s' $(( $1 / 1024 )); }
if [ "$swapfile_active" = 1 ]; then active_note=active; else active_note=inactive; fi
summary="$(printf 'SwapTotal %s MiB, %s %s MiB (%s), %s MiB free on %s, vm.swappiness=%s' \
  "$(mib "$swap_total_kb")" "$SWAPFILE" "$(mib "$file_kb")" "$active_note" \
  "$(mib "$free_kb")" "$(dirname "$SWAPFILE")" "$swappiness")"

case "$state" in
  ok)
    printf '%s -> ok, 2 GiB already in place\n' "$summary"
    exit 0 ;;
  persist)
    printf '%s -> swap is big enough but not persisted\n' "$summary" ;;
  create)
    printf '%s -> will create a 2 GiB %s\n' "$summary" "$SWAPFILE" ;;
  recreate)
    printf '%s -> will grow %s to 2 GiB (swapoff, recreate in one run)\n' "$summary" "$SWAPFILE" ;;
  refuse-disk)
    printf '%s -> refused: %s MiB short of keeping %s MiB free with a 2 GiB swapfile. Reclaim first (docker image prune -a, journalctl --vacuum-size=100M; docs/SMALL-HOSTS.md §6), or lower --min-free-mib.\n' \
      "$summary" "$(mib $(( RESERVE_KB - after_kb )))" "$MIN_FREE_MIB"
    exit 2 ;;
  refuse-ram)
    printf '%s -> refused: %s MiB is paged out and only %s MiB of RAM is available, so swapoff would fail. Free memory first, or use the bridge procedure in docs/SMALL-HOSTS.md §2.\n' \
      "$summary" "$(mib "$in_use_kb")" "$(mib "$mem_available_kb")"
    exit 2 ;;
esac

if [ "$MODE" = check ]; then
  exit 10
fi

# The seams point every path into a temp dir under test; a real run touches
# /swapfile and /etc/fstab and must be root.
if [ "$SWAPFILE" = /swapfile ] && [ "$(id -u)" != 0 ]; then
  die "--apply must run as root"
fi

if [ "$state" = create ] || [ "$state" = recreate ]; then
  # One process from here to swapon: an operator who runs "swapoff" and
  # "swapon" as two commands leaves the host with no swap in between, which on
  # a 512 MiB box is where the OOM killer arrives.
  if [ "$state" = recreate ]; then
    # Deliberately not `|| true`: in this state the file is active by
    # definition, so a failing swapoff must stop the run before the rm.
    swapoff "$SWAPFILE"
  fi
  rm -f "$SWAPFILE"
  # umask covers the window between creation and chmod.
  ( umask 077; fallocate -l 2G "$SWAPFILE" 2>/dev/null || dd if=/dev/zero of="$SWAPFILE" bs=1M count=2048 status=none )
  chmod 600 "$SWAPFILE"
  mkswap -q "$SWAPFILE"
  swapon "$SWAPFILE"
  # A file that is now active always wants its fstab entry.
  swapfile_active=1
fi

if [ "$swapfile_active" = 1 ] && ! grep -qE "^[[:space:]]*${SWAPFILE}[[:space:]]" "$FSTAB" 2>/dev/null; then
  printf '%s none swap sw 0 0\n' "$SWAPFILE" >> "$FSTAB"
fi
printf 'vm.swappiness=10\n' > "$SYSCTL_CONF"
sysctl -q -w vm.swappiness=10

printf 'swap: %s now has 2 GiB, persisted in %s, vm.swappiness=10\n' "$SWAPFILE" "$FSTAB"
