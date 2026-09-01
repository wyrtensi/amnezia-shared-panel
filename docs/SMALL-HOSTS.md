# Running on a small host (512 MB - 1 GB)

Shared Panel runs on a cheap VPS, but a small host fails in ways a large one does
not — and mostly not by running out of RAM. This is the canonical page for those
failure modes and the settings that avoid them. Every number here was measured on
a 961 MiB / 1 vCPU / 10 GB host running the panel and a co-located AWG3 node.

Related: [`INSTALL.md`](./INSTALL.md) (§ prerequisites),
[`ROLLOUT.md`](./ROLLOUT.md), [`NODE-CONNECT.md`](./NODE-CONNECT.md).

---

## 1. Budget

| | Panel alone | Panel + co-located node |
|---|---|---|
| RAM | 512 MB + swap | 1 GB + swap |
| Swap | 1 GB | 2 GB |
| Disk | 10 GB | 10 GB, kept below ~70 % |
| vCPU | 1 | 1 |

Measured steady state of the whole stack on the reference host: panel ~96 MiB
across four containers (web 32, worker 39, control-api 12, postgres 13), node
~57 MiB (node-agent 51, AWG3 6). The headroom above that is not slack — it is
what absorbs an image pull, a migration, and the transient container preflight
starts.

## 2. Add swap before anything else

```bash
fallocate -l 2G /swapfile && chmod 600 /swapfile && mkswap /swapfile && swapon /swapfile
echo '/swapfile none swap sw 0 0' >> /etc/fstab
sysctl -w vm.swappiness=10 && echo 'vm.swappiness=10' > /etc/sysctl.d/99-swappiness.conf
```

`vm.swappiness=10` keeps the kernel from paging out a working set that is still
hot, while still letting it evict genuinely idle pages instead of invoking the
OOM killer. Verify with `swapon --show` and `free -m`.

The cost is honest and worth stating: a swapfile is 1-2 GB of a 10 GB disk, and
paging on a VPN node trades latency for survival. Take the trade — the
alternative is a global OOM kill, which on this stack means the database or the
node-agent, not the process that asked for the memory.

## 3. Never build images on a small host

The panel is **pulled** from GHCR (`PANEL_IMAGE` + `infra/prod/update.sh`), and
that is the only supported path here. A `next build` on the reference host was
killed by the OOM killer at 638 MB resident, taking the whole host with it — it
was a *global* OOM, not a cgroup one.

The node-agent image is the exception the docs still ask you to build on the
node (`infra/node/scripts/build-node-agent.sh`). On a small host, prefer shipping
the already-built image from the panel host instead — that is what
`scripts/add-node.sh` does by default (`NODE_AGENT_IMAGE_SOURCE=panel`). If you
must build locally, bound it:

```bash
DOCKER_BUILDKIT=1 docker build --memory 512m --memory-swap 1g ...
```

## 4. Task budgets, not just memory

This is the failure that actually bites, and it looks nothing like memory
pressure: the container is healthy, using a tenth of its memory ceiling, and
suddenly reports

```
wget: fork: Resource temporarily unavailable
OCI runtime exec failed: unable to start container process: procReady not received
```

What is exhausted is the cgroup's **task** budget. Systemd's `DefaultTasksMax` is
a percentage of `kernel.threads-max`, and `threads-max` is derived from physical
RAM — on the 961 MiB reference host that resolves to **1055 tasks per container
scope**, and a 512 MB host gets roughly half. Any slow leak that would take days
to matter on a 4 GB box wedges a container here in hours.

Both stacks now defend against this and you should keep it that way:

- **`init: true`** on every long-running service. PID 1 in these containers is
  `pnpm`/`node`, which does not reap adopted children; the healthcheck's busybox
  `wget` forks an `ssl_client` helper that is orphaned on every run. Without an
  init that is one zombie per healthcheck interval, forever.
- **`pids_limit`** (`PANEL_PIDS_LIMIT`, `POSTGRES_PIDS_LIMIT`, default 256;
  the node stack uses 128). This does not fix a leak — it contains one, so the
  container restarts instead of quietly consuming the host's task budget.

Diagnosing it:

```bash
id=$(docker inspect --format '{{.Id}}' <container>)
cat /sys/fs/cgroup/system.slice/docker-$id.scope/pids.{current,max}
ps -eo stat,ppid,comm | awk '$1 ~ /Z/' | wc -l
dmesg -T | grep 'pids controller'
```

## 5. Give Postgres settings that match its ceiling

`infra/prod/compose.yaml` caps Postgres at `POSTGRES_MEM_LIMIT` (192 MiB by
default) so a co-located node's VPN containers can never be OOM-killed by the
panel. A ceiling without matching engine settings is a *delayed* OOM rather than
a protection: stock Postgres asks for 128 MB of `shared_buffers` and allows 100
backends that can each claim `work_mem`. It looks fine right up until it isn't,
because `shared_buffers` is faulted in lazily.

The compose file therefore starts Postgres with explicit values, all overridable
in `.env`:

| Variable | Default | Note |
|---|---|---|
| `POSTGRES_MEM_LIMIT` | `192m` | cgroup ceiling |
| `POSTGRES_SHARED_BUFFERS` | `32MB` | |
| `POSTGRES_WORK_MEM` | `2MB` | per sort, per backend |
| `POSTGRES_MAINTENANCE_WORK_MEM` | `32MB` | |
| `POSTGRES_EFFECTIVE_CACHE_SIZE` | `128MB` | planner hint only |
| `POSTGRES_MAX_CONNECTIONS` | `50` | floor is 30: `max: 10` per pool × control-api, worker, migrate |

On a host with memory to spare, raise them — these defaults trade throughput for
survival, which is the wrong trade on a large box.

## 6. Disk is usually the binding constraint

`infra/node/scripts/preflight.sh` requires **3 GiB free** before a node deploy,
and that gate is not negotiable — the deploy really does need the space. When it
refuses, reclaim rather than lower it:

```bash
docker image prune -a          # superseded images are usually >1 GB
journalctl --vacuum-size=100M  # /var/log grows past 400 MB unattended
docker system df               # shows what is actually reclaimable
```

## 7. Size the node to its real capacity

`SERVER_MAX_PEERS` in `infra/node/.env` is what the RAM gate in `preflight.sh`
scales against: the requirement is `350 MiB × SERVER_MAX_PEERS / 500`, floored at
192 MiB — so any node configured for 268 peers or fewer needs 192 MiB available,
and a 500-peer node still needs the full 350 MiB.

Leaving the template's `500` on a small host therefore asks for the maximum
requirement regardless of what the node will actually carry. Set it to the
capacity you intend; 500 remains the hard upper bound.

## 8. Shell gotcha worth knowing

Bounded repetition in a POSIX character class is not free. On GNU grep 3.11,
`grep -E '^[[:graph:]]{32,4096}$'` over a 65-byte file costs **281 MB RSS and
20 seconds on one vCPU** — the same expression with `*` costs 1.9 MB and no
measurable time. On a small host the OOM killer reaps the grep and the script
reports the *validation* as failed, which sends you looking in the wrong place
entirely. Prefer a linear formulation (`tr -d '[:graph:]'` and a length check).
