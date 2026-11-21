# Reachability probe: re-check right after a configuration change

Status: 2026-11-21. Builds on `docs/REACHABILITY-PROBE.md` and
`docs/AWG-GENERATOR.md`.

## Intent

Every registered IPv4 is a separate server for users, and the probe must
measure each one with the same configuration build its users get. The probe
already projects every target from the current generator profile at each run,
but runs are hourly: after a profile change the address reads "no data" for up
to an hour. Administrators want the probe to pick a change up by itself.

## Behaviour

- After a committed change to what the probe measures, on a node with checks
  on, the panel queues a probe run (`run_requested_at`). The worker starts it
  at its next tick (one minute) or as soon as the run in flight ends.
- The changes that queue a run: the node's generator profile; an address
  added; an enabled address's generator profile or bridge mode; an address
  enabled or disabled; checks turned on for an address or the node; the
  node's bridge route assignment; the portal's bridge default; the node agent
  reporting a new primary address (worker telemetry). Renames and other edits
  do not.
- Nothing is queued while the probe is disabled or absent. A request written
  while a run is in flight is served right after that run.
- The "run requested" badge shows only while a request is pending, not forever
  after the first manual run.
- A live AWG 3 probe service key without a client profile (keys issued before
  profiles existed) gets one in migration 0066, drawn from the same ranges as
  new keys, and the migration queues a run. Without a generator preset the
  probe then measures like new user keys. The profile is client-side only, so
  the key is not reissued; its target IDs change once. (A runtime assignment
  in the worker's key sync was tried first and dropped: it rewrote the
  identity of every legacy-key fixture the bridge tests rely on, for a one-time
  fix of old rows.)

## Approaches considered

1. **Queue after commit** (chosen): a separate `UPDATE reachability_probe`
   (`requestReachabilityRun` in `packages/db`) after the transaction commits.
   The worker's lock order is probe row, then node rows, so the probe row
   cannot be written under the node lock. Its wait for the probe row is capped
   with `lock_timeout` (a dispatch holds that row across its request to the
   probe); if the write fails the edit stands, a warning is logged and the
   scheduled run measures it.
2. Same transaction, probe row locked first: atomic, but every node edit would
   take the probe row lock and serialize with every dispatch and ingest.
3. Worker derives "due" from evidence reset markers: no new write, but address
   additions and enables leave no marker, and it couples to detail strings.

## Out of scope

The node-level target (widget and node alerts) still uses the service key's
issued host after the primary address changes; per-address checks are not
affected.
