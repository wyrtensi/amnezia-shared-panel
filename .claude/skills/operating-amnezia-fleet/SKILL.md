---
name: operating-amnezia-fleet
description: Use when releasing, deploying the panel, updating or restarting anything on a production host or node of this project, when the operator says "push, build, deploy" (or "пуш билд деплой", "выкатывай", "обнови ноды"), or when writing anything about specific hosts, nodes or users into a file that git tracks.
---

# Operating the amnezia fleet

## Overview

The fleet carries live users, and the repository is public. Which hosts exist,
which ones may be deployed to without asking, and their traps live in one
git-ignored file: `FLEET.local.md` in the repository root of the main checkout
(`git rev-parse --path-format=absolute --git-common-dir`, then its parent). That
file is the only source for host facts. This skill says how to act on it. The
mechanics are in `docs/` (`OPERATIONS.md`, `DEPLOY-UPDATE.md`, `NODE-CONNECT.md`,
`AGENT-HOST-SETUP.md`, `UPDATE-MECHANISM.md`); read the section you need there.

## 1. Read `FLEET.local.md` first

Before any command that reaches a host, read it. If it is missing, stop and ask
the operator; do not rebuild the fleet from memory, handoffs or `docs/`. If a
fact in it turns out wrong, fix the file in the same session and date the row.

## 2. What "push, build, deploy" authorises

The phrase is a complete instruction. Do all of it without stopping to ask:

1. Merge your own PR once CI is green.
2. Tag the next patch version (0.0.1 step) from `origin/main` and wait for the
   release workflow run that belongs to that tag.
3. Deploy the panel to every host whose row says **Deploy without asking: yes**,
   in table order, each verified (section 4) before the next.
4. "…and the nodes" adds: panel-driven agent updates, one node at a time, for
   nodes whose row says **yes**.

Stop and ask only when one of these is true:

| Condition | Why |
|---|---|
| A host or node row says **no**, or says **(confirm)** | The operator decides that host per session |
| Nothing new on `origin/main` since the last tag | An empty release is never the intent |
| A migration drops, renames or rewrites data | Not reversible by rolling the image back |
| The step would restart AWG or recreate a node's compose stack | Users' tunnels drop |
| A host's state differs from its row (unknown containers, pinned image, disk or RAM gate fails) | The row is stale; ask, then fix the row |
| A verification check fails | Stop the rollout there; the next host waits |

Do not ask about a maintenance window, about merging a green PR of your own, or
about hosts marked **yes**: the operator answered that by saying the phrase.

## 3. Nodes

- Update agents only through the panel (`node-agent-update --confirm`), one
  node at a time; wait for the reported agent version, not for "not running".
- Before any node work, run the foreign-container check from `FLEET.local.md`.
  A container that is not ours is never stopped, removed, renamed or recreated;
  on such a node use `--no-deps` only and never run `deploy.sh` whole.
- Anything that restarts a container other than the agent: ask first, on every
  node.

## 4. Evidence, not exit codes

Report per host, with output: the version read from the image, `last_sync_at`
moving for every node row, worker errors (`level:50`) at zero over five minutes,
peers in `awg0.conf` equal to live peers, AWG container start time unchanged.
`FLEET.local.md` has the exact commands. A step that exited 0 proves nothing.

## 5. The public repository

Before every commit and every PR, check the staged change against the names and
addresses in `FLEET.local.md`:

```sh
git diff --cached -U0 | grep -n -i -E '<every host name, address and domain from FLEET.local.md, joined with |>'
```

Any hit stays out: move it to `agent-changes/` or `plans/` (both ignored) or to
`FLEET.local.md`. The same applies to user emails and user counts. Handoffs in
`agent-changes/` may name hosts.

## Common mistakes

| Mistake | Instead |
|---|---|
| Asking "deploy to the proving ground?" after "push, build, deploy" | Deploy to every **yes** host; ask only per the table in section 2 |
| Treating a release as permission for every host | Releasing and deploying a **no** host are separate decisions |
| Recreating a node stack to update the agent | Panel-driven agent update, `--no-deps` |
| Removing a container that blocks `compose up` | Check its compose label; foreign ones are never touched |
| Copying a host name into `docs/` "as an example" | Placeholders in `docs/`, real names only in ignored files |
| Leaving `FLEET.local.md` stale after a change | Update the row and its date in the same session |
