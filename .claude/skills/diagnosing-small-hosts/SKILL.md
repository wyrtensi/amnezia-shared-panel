---
name: diagnosing-small-hosts
description: Use when a container or service on a 512 MB - 1 GB VPS is unhealthy, wedged, OOM-killed, or refusing to fork ("Resource temporarily unavailable", "procReady not received", "Cannot allocate memory"), when a deploy gate rejects a host for RAM or disk, or when sizing this stack for a small box.
---

# Diagnosing small hosts

## Overview

On a 512 MB - 1 GB host, most failures are *not* the process running out of
memory. They are budgets that scale with RAM: task counts, kernel limits, and
gates sized for a bigger machine. Measure which budget is exhausted before
changing anything — the memory number is usually the least informative one.

**Core principle:** find the exhausted budget, not the biggest number.

## The four budgets, in the order they actually break

| Symptom | Exhausted budget | First command |
|---|---|---|
| `fork: Resource temporarily unavailable`, `procReady not received`, `docker exec` fails while the app still serves | cgroup **tasks** | `cat /sys/fs/cgroup/system.slice/docker-$ID.scope/pids.{current,max}` |
| Deploy gate refuses the host; `docker pull` fails midway | **disk** | `df -h /; docker system df; du -sh /var/log` |
| Process killed with no warning, host briefly unresponsive | **memory** (global OOM) | `dmesg -T \| grep -i 'out of memory'` |
| Container restarts in a loop under load | **memory** (cgroup OOM) | `cat /sys/fs/cgroup/.../memory.events` |

Note the first row: a healthy-looking, low-memory container that cannot fork is
the signature failure of a small host, and nothing about it points at memory.

## Why task budgets are a small-host problem

`DefaultTasksMax` is a percentage of `kernel.threads-max`, and `threads-max` is
derived from physical RAM. On a 961 MiB host it resolves to **1055 tasks per
container scope**; a 512 MB host gets roughly half. Any leak that would take
days to matter on a 4 GB box wedges a container here in hours — and gets blamed
on the application.

```bash
systemctl show --property=DefaultTasksMax     # the budget
ps -eo stat,ppid,comm | awk '$1 ~ /Z/' | sort | uniq -c   # the leak, usually zombies
dmesg -T | grep 'pids controller'             # the moment it ran out
```

Zombies parented to a container's PID 1 mean PID 1 is not an init. `pnpm`,
`node`, `python` and most app entrypoints never reap adopted children — and a
busybox `wget` healthcheck forks an `ssl_client` helper that is orphaned on
every single run.

Fix: `init: true` on the service (reaps), plus `pids_limit` (contains — the
container restarts instead of eating the host's budget). Both are in
`infra/prod/compose.yaml` and `infra/node/compose.yaml`; keep them there.

## A memory ceiling is not a memory setting

A `mem_limit` on a database or JVM without matching engine settings is a
*delayed* OOM, not a protection. Postgres in a 192 MiB cgroup still asks for
128 MB of `shared_buffers` and allows 100 backends that can each claim
`work_mem`. It looks fine because `shared_buffers` is faulted in lazily, right
up until a real query arrives.

Whenever you set a ceiling, set the engine settings under it. See
`docs/SMALL-HOSTS.md` §5 for this project's values.

## Rules that hold on every small host

- **Add swap first** (1-2 GB, `vm.swappiness=10`), before tuning anything.
  Paging costs latency; a global OOM kill costs the database.
- **Never build container images there.** A `next build` was OOM-killed at
  638 MB resident on the reference host, taking the whole box with it. Pull, or
  ship the image from a bigger machine.
- **Reclaim disk, do not lower the gate.** `docker image prune -a`,
  `journalctl --vacuum-size=100M`. A gate that refuses is reporting a real
  shortage; a lowered gate hides it until the deploy fails halfway.
- **Bounded repetition in shell regexes is not free.** `grep -E
  '^[[:graph:]]{32,4096}$'` costs 281 MB RSS and 20 s on one vCPU (GNU grep
  3.11, measured); the same class with `*` costs 1.9 MB. The OOM killer reaps
  it and the script then blames whatever it was validating. Prefer a linear
  form (`tr -d`, plus an explicit length check).
- **Size capacity gates to declared capacity, and ask for the capacity.** A
  gate that scales with `SERVER_MAX_PEERS` does nothing while every node ships
  the template's maximum.

## Common mistakes

| Mistake | Why it fails |
|---|---|
| Raising `mem_limit` when a container cannot fork | The limit was never the constraint; `pids.max` was |
| Adding `pids_limit` without `init: true` | Contains the leak, does not stop it — the container now restarts forever |
| Reading `docker stats` and concluding "plenty of memory" | True and irrelevant for task, disk and kernel-limit failures |
| Lowering a preflight gate to make a deploy proceed | The gate is the only thing reporting the shortage |
| Treating `MemAvailable` at deploy time as steady state | It is a snapshot; passing a gate says nothing about load |

## Reference

`docs/SMALL-HOSTS.md` — this project's measured numbers, the tunable
environment variables, and the swap/disk/build procedures.
