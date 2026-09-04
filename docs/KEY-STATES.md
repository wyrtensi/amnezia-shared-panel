# Key states

A VPN key has exactly six states. They are declared once in
`packages/db/src/schema.ts` (`keyStateEnum`) and mirrored in
`packages/contracts/src/index.ts` (`keyStateSchema`); a parity test fails if the
two drift.

This document exists because the list was read differently in three places at
once, and the disagreement was visible to users: a key deleted from a node that
happened to be down came back in the owner's list labelled "Error", and could
not be deleted again.

---

## The six

| State | Reached from | Reached by | The owner sees | Terminal |
|---|---|---|---|---|
| `provisioning` | — (creation) | user or admin creating a key | the key, marked as being set up | no |
| `active` | `provisioning`, `disabled` | worker completing a provision; admin *enable* | the key, usable | no |
| `disabled` | `active` | admin *disable* | the key, marked disabled | no |
| `revoking` | `provisioning`, `active`, `disabled`, `revoking`, `failed` | owner *delete*; admin *revoke*; admin *offboard user* | nothing — the key is gone from their list | no |
| `revoked` | `revoking` | worker completing a revoke | nothing | **yes** |
| `failed` | `provisioning` | worker giving up on a provision job | the key, with the failure reason | no |

Only `revoked` is terminal. `failed` is not: a key whose provisioning failed can
still be deleted, which is the only thing left to do with it.

## The one rule that keeps being broken

**`failed` means "this key never came into existence".** Nothing else.

A revoke that does not complete stays in `revoking` and records its reason in
`failure_reason`. It does **not** become `failed`. The two situations are
different in the only way that matters — what the person who asked for it
wants — and merging them into one state produced a key the owner had deleted,
shown back to them as an error, that the API then refused to delete.

`apps/worker/src/postgresRepository.ts` (`failJob`) is where this is enforced.

## Who sees what

**Owners** see every state except the ones in `HIDDEN_KEY_STATES`
(`apps/web/lib/key-states.ts`): `revoking` and `revoked`. Both mean the owner
already asked for the key to be gone, including the case where the last attempt
failed. `failed` is *not* hidden — a provisioning failure is theirs to see and
act on.

**Admins** see every state verbatim, with no filtering anywhere. An operator
debugging a stuck delete needs to see the key that is stuck.

## When a delete may be asked for

`REVOCABLE_KEY_STATES` in `packages/contracts/src/index.ts`, used by both the
control API (`enqueueOwnRevoke` and the admin `keys/revoke` action) and the
admin panel's button, so the two cannot disagree:

`provisioning | active | disabled | revoking | failed`

`revoking` is in the list on purpose: that is where a delete waits when the node
was unreachable, and asking again is the retry. `failed` is in the list both for
provisioning failures and for rows written before the rule above was enforced,
which are stuck there.

Every attempt queues a **fresh** job — the outbox deduplication key carries a
per-attempt suffix. A fixed key deduplicated the retry against the row of the
attempt that had already failed, so the request was accepted and enqueued
nothing. The worker's revoke handler looks the peer up before deleting it, so a
duplicate job against an already-deleted peer completes cleanly.

## Adding a seventh state

Three things must change together, and each has a test that fails without it:

1. `keyStateEnum` in `packages/db/src/schema.ts` and `keyStateSchema` in
   `packages/contracts/src/index.ts` — the parity test pins them to each other.
2. This table.
3. `apps/web/lib/key-states.ts` — `key-states.test.ts` reads the contract's
   state list and fails when a state has no decision recorded here, so a new
   state cannot reach a user's list by default.

Then ask whether the new state belongs in `REVOCABLE_KEY_STATES`.

## Deleting a key from the panel

Revoking a key gets rid of the peer. The row stays: it is what the traffic
history, the audit trail and the node's key count are attached to.

`PURGEABLE_KEY_STATES` in `packages/contracts/src/index.ts` says when the row
itself may go, and it holds exactly one state:

`revoked`

That is the only state where the node has **confirmed** the peer is gone. In
every other state something may still be on a node -- `provisioning` may have
got half way, `active` and `disabled` certainly have one, `revoking` is waiting
for the node to answer, and `failed` may have created a peer before the job gave
up -- and deleting the row is what strands it: reconcile finds an orphan by the
label the row carries, so with the row gone nothing knows what that peer was.
The API answers `409 KEY_NOT_PURGEABLE` and says to delete the key first.

The delete takes the row, its `peer_current`, `traffic_samples` and
`traffic_rollups` (all cascade), and any `job_outbox` rows still carrying the
key id -- those do **not** cascade, because the id lives in a JSON payload
rather than in a foreign key, and a leftover job makes the worker retry for a
key that no longer exists.

Afterwards the only record is the audit event `admin.keys.purge`, which is why
it carries the owner, the node, both labels and the dates rather than just an
id: it is the last thing that can answer "what was this?".

Surfaces: `key-purge <id> --confirm` in the CLI, and **Delete from panel** on an
admin's key row. There is no owner-facing equivalent, and there should not be:
owners never see a revoked key at all.
