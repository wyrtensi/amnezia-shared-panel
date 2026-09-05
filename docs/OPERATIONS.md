# Operating the servers, day to day

Two things live here, and nothing else.

**A map.** `docs/` holds thirteen other files and their titles overlap; at 3am you
should not have to open four of them to find out which one owns your job. §1 is
that index. If your job is in it, follow the link and stop reading this file.

**The day-2 procedures.** Changing something on a server that is already carrying
users is a different act from installing one, and the install runbooks do not
cover it: how to know an update will not reset anybody's key, how to move the
data plane to a new engine build, what an edit to a generated config has to
satisfy, when a targeted recreate leaves you without a backup, and how to look at
a panel→node tunnel. That is §2 onwards.

Cross-links are deliberate. Where another document already carries a procedure,
this one says so in a line and points at it rather than growing a second copy
that will drift.

Placeholders (`<node dir>`, `<NODE_NAME>`, `<tunnel port>`) follow the rest of
`docs/`. Anything specific to one deployment — real addresses, node names,
digests, counts — belongs in the git-ignored `plans/`, which is the only place in
this tree where it is allowed to live.

---

## 1. Which document owns your job

| The job | The document that owns it |
| --- | --- |
| Stand the whole thing up for the first time | [`INSTALL.md`](./INSTALL.md) — start there, it routes the rest |
| Install a VPN node on a bare host | [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) Part A; `scripts/add-node.sh` does the whole rollout in one command ([`NODE-CONNECT.md` §0](./NODE-CONNECT.md#0-the-scripted-path)) |
| Connect an already-running node to the panel | [`NODE-CONNECT.md`](./NODE-CONNECT.md) |
| Raise the panel and put a login in front of it | [`HOSTING.md`](./HOSTING.md) for the shape, [`CLOUDFLARE-SETUP.md`](./CLOUDFLARE-SETUP.md) for the clicks |
| Access application, allowlist, two-way sync | [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) |
| Deploy the whole estate in order | [`ROLLOUT.md`](./ROLLOUT.md) |
| Update the panel | [`DEPLOY-UPDATE.md`](./DEPLOY-UPDATE.md); the Update button's internals are in [`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md) |
| Update a node's agent | [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md), "Updating a node's agent from the panel" — every failure mode is there. §3 below is the short form and the one rule it turns on |
| Move the data plane to a new `amneziawg-go` build | **§4 here.** Nothing else covers it |
| Confirm a change will not reset users' keys | **§2 here.** Nothing else covers it |
| Change how many peers a node accepts | `amnezia-panel node-capacity` or `scripts/set-capacity.sh` — both in [`CLI.md`](./CLI.md); why the number matters is [`SMALL-HOSTS.md` §7](./SMALL-HOSTS.md) |
| Open, inspect or repair a panel→node tunnel | [`NODE-CONNECT.md` §2](./NODE-CONNECT.md#2-reaching-the-node-from-the-panel) chooses the transport; **§7 here** operates it |
| A container is wedged, OOM-killed, or a gate refuses the host | [`SMALL-HOSTS.md`](./SMALL-HOSTS.md) |
| Free disk on a server | [`SMALL-HOSTS.md` §6](./SMALL-HOSTS.md); **§6 here** for the extra rules on a node |
| Find the command for anything | [`CLI.md`](./CLI.md) |
| Work out what a key's state means | [`KEY-STATES.md`](./KEY-STATES.md) |
| Add or calibrate a service check | [`SERVICE-CHECKS.md`](./SERVICE-CHECKS.md) and [`runbooks/service-check-calibration.md`](./runbooks/service-check-calibration.md) |

---

## 2. Will this reset users' keys?

That question has an answer you can read off the disk. It is not a matter of
hoping.

Everything a client's config pins — the AWG server keypair, the obfuscation
geometry, and the peer list — lives in **one file**, `awg0.conf`, in the node's
own state directory, plus the key files beside it:

```
<node dir>/state/amnezia-awg3/
  awg0.conf                             # server private key, geometry, every [Peer]
  wireguard_server_private_key.key
  wireguard_server_public_key.key
  wireguard_psk.key                     # the shared per-peer PresharedKey
  clientsTable                          # the agent's own JSON sidecar
```

`infra/node/scripts/awg3-entrypoint.sh` generates all of it inside a single
branch gated on `[ -f "$CONFIG_FILE" ]`. **If `awg0.conf` is there, nothing is
generated.** Peers are put back onto the interface at start by one
`awg setconf awg0` from `awg-quick strip awg0.conf`, which is a full replace — so
the peer set on the running interface is exactly the `[Peer]` blocks in that
file, with nothing else contributing.

The header-protection key is the exception worth knowing: it is written **only**
into `awg0.conf`, never to a key file. Lose that file and it is gone, and with it
every client config issued from the node.

### The check

Take these before the change and again after. They must match each other, and
the pair must be unchanged across the change.

```sh
# peers the config persists
grep -c '^\[Peer\]' <node dir>/state/amnezia-awg3/awg0.conf

# peers the running interface holds
docker exec amnezia-awg3 sh -lc 'awg show awg0 peers' | wc -l

# the identity every issued client config pins
docker exec amnezia-awg3 sh -lc 'awg show awg0 public-key'
```

Use `peers`, not `dump`: `awg show awg0 dump` answers the same question but its
first line carries the **server private key**, and that must not land in a
terminal you will paste from. `scripts/set-capacity.sh` prints the same `peers`
count for the same reason.

The one node that ever lost its keys had lost the whole state directory first.
An entrypoint that finds the config does not touch it.

### What an existing config must satisfy, or the container stops

A config that is present but inconsistent is **refused**, not silently rebuilt.
The entrypoint exits, and because the service is `restart: unless-stopped` the
container then crash-loops and a deploy's health gate times out. In full
(`infra/node/scripts/awg3-entrypoint.sh`):

| Refusal | Condition |
| --- | --- |
| `AWG3 config exists but key material is incomplete` | fewer than the three key files beside a present config |
| `AWG3 state exists but config is missing` | key files or `clientsTable` present, `awg0.conf` gone |
| `AWG3 config exists but clientsTable is missing` | no `clientsTable` |
| `AWG3 config private key does not match persisted key material` | `PrivateKey` in the config differs from the key file |
| `AWG3 public key does not match the persisted private key` | `awg pubkey` of the stored private key differs from the public key file |
| *(unlabelled)* | the stored PSK is not a valid key — `awg pubkey` fails and takes the script with it, with no `Refusing to start:` line. Do not grep only for that prefix |
| `AWG3 config must use 10.90.0.1/22` | the `Address` line was changed |
| `AWG3 config must use UDP 51890` | the `ListenPort` line was changed |
| `AWG3 config must define HeaderProtectionKey` | the marker that proves genuine 3.1 is absent |

Two limits on that list, both worth knowing before you rely on it:

- **Geometry is not re-checked on an existing config.** The generator refuses
  `Jmin >= Jmax` and a dozen other invalid draws, but that check runs only on
  first initialization. A hand-edited `awg0.conf` with an inverted junk range
  starts, and `amneziawg-go` then computes each junk packet as
  `min + fastrandn(max - min)` on `uint32` — a multi-gigabyte allocation per
  handshake, which nothing downstream catches.
- **A `.initializing` marker overrides everything above.** If a previous first
  start was interrupted, the entrypoint deletes the config, the key files and
  `clientsTable` and regenerates before any of these checks run. That is
  deliberate crash recovery, and it is the one path on which a present config is
  destroyed. If you find `state/amnezia-awg3/.initializing` on a node that has
  live peers, stop and work out why it is there before starting the container.

### What a refresh copies

Only one path in this repo copies the node tree onto a host —
`scripts/add-node.sh`, streaming a `tar` over ssh — and it excludes `state`,
`secrets`, `.env`, `backups` and `tests` at any depth. `infra/node/scripts/deploy.sh`
and `backup.sh` copy nothing at all; they pull images and drive compose. So a
refresh of the node tree cannot reach `awg0.conf`, and the answer to "will this
reset the keys" is the file check above, not the copy semantics.

---

## 3. Updating a node's agent

Full mechanism, wiring step and every failure mode:
[`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md), "Updating a node's agent from
the panel". Two things about it are day-2 rules rather than install detail.

**Recreate only the agent.** The node-agent is the panel's management channel,
not the data path — it holds no TUN device, no `NET_ADMIN`, and no public port,
while `amnezia-awg3` holds all three. Replacing it drops nothing:

```sh
docker compose --env-file .env -f compose.yaml up -d --no-deps node-agent
```

`--no-deps` is load-bearing, because `node-agent` declares `depends_on` on
`awg3`; without it compose recreates the data plane and every live tunnel drops.
`scripts/agent-update.sh` uses `--no-deps` on both its install and its rollback
path, and a test asserts every `compose up` in that script carries it. On a host
shared with an unrelated install `--no-deps` matters a second time over, because
a plain `up -d` reaches for services whose container names a foreign install may
already hold — see
[`NODE-CONNECT.md`, "Shared hosts"](./NODE-CONNECT.md#shared-hosts--do-not-disturb-other-tenants).

**The first hop to 1.1.9 is made over SSH.** The panel can drive the update
(the node card's button, or `amnezia-panel node-agent-update`), but only from
node-agent **1.1.9** onwards. On 1.1.3 through 1.1.8 both `/server/update`
routes answer `500` — awilix in CLASSIC mode could not construct
`AgentUpdateService` — and there is no floor in the panel that stops you trying,
because **the panel never learns which agent version a node runs**: no agent
response carries a version and no column records one. The button tries and
fails.

That failure is invisible. The worker's `node.agent-update` job throws on the
POST and never marks the node `requested`; the telemetry poller only reads
`GET /server/update` for a node already in `requested` or `running`, and swallows
errors when it does; the processor's log hook is wired for the Access sync only.
The reason is written to `job_outbox.last_error` and to nothing that any screen
reads. Get the node to 1.1.9 over SSH first
([`NODE-CONNECT.md`, "Getting the node-agent image onto a host"](./NODE-CONNECT.md#getting-the-node-agent-image-onto-a-host));
every version after that installs from the button.

---

## 4. Moving the data plane to a new engine build

The `amneziawg-go` image is pinned by digest in `infra/node/scripts/common.sh`
and `infra/node/compose.yaml`, and `verify_awg3_image()` fails a deploy whose
pulled image does not match. Moving to a new build is therefore a repo change
first and a node change second.

1. Change the pin in `infra/node/scripts/common.sh` and `infra/node/compose.yaml`
   together — a test asserts compose carries a `3.1.<date>@sha256:` reference,
   and `deploy.sh` compares what it pulled against `common.sh`.
2. **Pull it on the node first**, as its own step, with `docker pull` — not
   `docker compose pull`. The service carries `pull_policy: never` precisely so
   compose never fetches an image behind your back, and `deploy.sh` pulls the
   same way:

   ```sh
   docker pull --platform linux/amd64 amneziavpn/amneziawg-go:<tag>@sha256:<digest>
   ```

   Doing it first is what keeps the outage short. A pull inside the recreate
   stretches the window in which the interface is down from seconds to however
   long the layer transfer takes.
3. Recreate only `awg3`:

   ```sh
   docker compose --env-file .env -f compose.yaml up -d --no-deps --force-recreate awg3
   ```

It costs a few seconds of tunnel while the container restarts. Clients
re-handshake on their own — within 30 seconds in the moves done so far. Nothing
about the geometry changes: the entrypoint finds `awg0.conf`, generates nothing,
and `awg setconf` puts the same peers back, which is what keeps configs already
in users' clients working. Verify it with the peer and public-key check in §2,
before and after.

### One ordering constraint that is not obvious

**`DisableCookies = on` is only safe from `amneziawg-go 3.1.20260828`.** Up to
and including `3.1.20260814` the `on` guard sat on cookie *sending* alone while
the MAC2 check stayed live, so a client arriving during a flood could never
obtain the cookie it needed and could not connect until the flood ended. `on`
locked out the node's own users instead of merely quieting the node. Move the
engine first, then the setting — never the other way round, and never pin an
older AWG3 image while the setting is on.

Nothing enforces that in code. There is no version probe in
`infra/node/scripts/awg3-geometry.sh`; the only guard is the digest pin plus
`verify_awg3_image()`, and both move the moment someone edits the pin. The
reasoning is in that script's comments — read it before changing either.

A related trap when you go looking at what a node has: the value is parsed by
amneziawg-tools' `parse_bool`, which accepts `on`/`off` **and** a decimal read as
`!= 0`. `DisableCookies = 0` is a legal spelling of "off". A check that tests for
the literal word `off` reports the feature as on when the daemon has it off.

---

## 5. Writing a value into a generated config

`awg3-geometry.sh` runs **once**, at first initialization, and never again —
rerolling the geometry would invalidate every key already issued from that node.
So `AWG3_DISABLE_COOKIES` and `AWG3_TUNNEL_MTU` in `compose.yaml` are read on
the very first start and ignored afterwards. Changing one on a node that is
already carrying users means editing `awg0.conf` by hand, and that edit has one
hard rule.

**It has to land inside `[Interface]`.** The file is one `[Interface]` block
followed by a growing list of `[Peer]` blocks: the node-agent appends
`\n[Peer]\n…` to the end of the file for every client it creates. So appending a
directive to the end of the file puts it inside the **last peer**, where it is a
per-peer key the daemon does not recognise rather than an interface setting. The
node starts, the setting does nothing, and there is no error anywhere.

Verify placement by line number against the first `[Peer]`:

```sh
cd <node dir>/state/amnezia-awg3
grep -n 'DisableCookies' awg0.conf     # must be smaller than
grep -n -m1 '^\[Peer\]' awg0.conf      # this
```

Then restart the container so the entrypoint reads the file again. The state
directory is a bind mount, so a plain `docker compose … restart awg3` is enough —
`--force-recreate` is for a change compose itself resolves (`.env`, `compose.yaml`),
not for a file the container reads through a mount. Re-run the §2 check
afterwards: you have just edited the file that holds every peer.

---

## 6. Disk, swap and backups

### Swap

Every server gets 2 GiB and `vm.swappiness=10`, from the one place that rule
lives: `scripts/ensure-swap.sh` ([`SMALL-HOSTS.md` §2](./SMALL-HOSTS.md) carries
the commands and the reasoning; this file does not repeat them).

It **refuses** — exit 2, `refused: … MiB short of keeping … MiB free` — when the
swapfile would not leave `--min-free-mib` free, default 3072. The refusal is
correct and the first answer is to reclaim disk, not to lower the bar. But a host
that genuinely cannot fit 2 GiB is a real case, and there are exactly three
things you can do:

- **Reclaim disk** (next, and [`SMALL-HOSTS.md` §6](./SMALL-HOSTS.md)). Do this
  first. It is almost always enough.
- **Lower `--min-free-mib`**, floor 1024. Understand what you are buying: the
  node's own preflight *fails* below 2 GiB free and warns below 3 GiB, so
  anything under 2048 here trades the swapfile for the next node deploy — you
  will get the swap and then be unable to redeploy the node until you reclaim
  anyway. Between 2048 and 3072 you keep deploys working and give up the margin
  that absorbs one image pull or one unattended month of logs.
- **Give the host a smaller swapfile by hand.** The script will not do it — the
  2 GiB target is a constant with no flag — so you leave the one place the rule
  lives, `--check` will report a needed change forever, and the next operator has
  no way to tell a deliberate 1 GiB from a half-finished 2 GiB. If you take this
  route, record it in `plans/` for that host.

### Reclaiming disk on a node

Rotated logs and images nothing runs. That is the whole list.

```sh
docker image prune -a            # superseded images; the usual >1 GB win
journalctl --vacuum-size=100M    # /var/log passes 400 MB unattended
docker system df                 # what is actually reclaimable
```

Never `docker system prune -a`, never prune volumes, and neither on a shared
host — the node's peer state is in bind mounts and another tenant's is not
yours to judge. This is the same rule `preflight.sh`, `ensure-swap.sh` and the
node metrics in the CLI all print when they refuse a host.

Removing two images does not free the sum of their sizes. Layers are shared, so
`docker system df` after the fact is the only honest number; the sizes in
`docker images` double-count everything two tags have in common.

### Back up before you change state

`infra/node/scripts/deploy.sh` takes a pre-deploy backup — **but only on a node
that also runs AWG2.** The backup is gated on `state/amnezia-awg2/awg0.conf`
being non-empty, so on a 3.1-only node it is silently skipped and every failure
branch of that deploy has no archive to point at. Do not assume a deploy left you
one; check `backups/` for an archive dated after you started.

The targeted `--no-deps` recreates in §3 and §4 take no backup at all, by design
— they exist precisely to avoid the stop that `backup.sh` needs for a consistent
snapshot.

So on a node carrying real users, take one by hand first. Note that
`scripts/backup.sh` covers `state/` **only**: `secrets/`, `.env` and
`compose.yaml` are not in the archive, and those are what you need to bring the
node back at all.

```sh
sh scripts/backup.sh                      # state/ — briefly stops the stack, announce it
tar -C <node dir> -czf ~/node-config.tar.gz secrets .env compose.yaml   # the rest
```

The archive holds VPN private material. Copy it to approved encrypted storage
and nowhere else; verify with `sha256sum -c <archive>.sha256` before you ever
restore from it.

---

## 7. The panel → node SSH tunnels

The node-agent publishes on `127.0.0.1:4001` and nowhere else, so the worker
reaches it over a supervised tunnel. [`NODE-CONNECT.md` §2](./NODE-CONNECT.md#2-reaching-the-node-from-the-panel)
covers the transport choice and prints the unit; `scripts/add-node.sh` installs
it as step 7 of 8. This section is how you look at one afterwards.

**The shape, in principle.** One `autossh` systemd unit per node on the panel
host, `panel-tunnel-<NODE_NAME>.service`, forwarding a distinct local port to the
node's `127.0.0.1:4001`. The forward is bound on the **Docker bridge gateway** —
a private address — because the worker runs in a container and reaches the host
through it. It is never bound on a public interface, and never on port 4001
itself: local ports are allocated from a base and stepped per node.

That bind address is also why the unit orders itself `After=docker.service`. The
gateway does not exist until Docker is up, and `ExitOnForwardFailure=yes` means
a tunnel that cannot bind exits rather than sitting there looking healthy.
`AUTOSSH_GATETIME=0` is what stops autossh giving up for good when the first
connection dies inside 30 seconds — exactly what happens when the node is down
while the panel host boots.

**The panel's own record points at that local port**, not at the node:
`add-node.sh` registers the node with
`apiBaseUrl: http://host.docker.internal:<tunnel port>`. `host.docker.internal`
resolves to the same bridge gateway the tunnel bound. So a node's `apiBaseUrl` is
a statement about the panel host's loopback-side plumbing, and changing the
tunnel's port without changing the record breaks the link with no error at either
end.

**Is it up?** Three checks, cheapest first:

```sh
systemctl status panel-tunnel-<NODE_NAME>          # active (running), one autossh + one ssh
ss -H -ltn | grep ':<tunnel port>'                 # a listener on the bridge gateway, not 0.0.0.0
docker compose -f infra/prod/compose.yaml exec control-api \
  wget -qO- http://host.docker.internal:<tunnel port>/healthz    # -> {"ok":true}
```

The third is the only one that proves the whole path, and it is the same check
`add-node.sh` runs before it will call a rollout finished.

**What a failed one looks like.** The unit stays `active (running)` — autossh is
alive and retrying — while the listener is gone and the `wget` hangs to its
timeout. In the panel the node goes unhealthy with
`lastError: "fetch failed"`, and provisioning jobs for that node fail; the worker
clears it on the first poll that succeeds. `journalctl -u panel-tunnel-<NODE_NAME> -f`
shows the retry loop, which widens from several attempts in the first second to
seconds apart. That is expected while a node is down and is not itself a fault.

**VPN users are unaffected the whole time.** Clients reach the node's UDP port
directly; the tunnel carries only the panel's management calls. A dropped tunnel
is a management outage, not a service outage — which is also why it can go
unnoticed, so a node showing `fetch failed` deserves the same attention as one
that is genuinely down.

---

## 8. Two habits that catch the rest

### Line endings will silently disable things

Everything under `infra/**` and `scripts/**` is copied verbatim onto a Linux host
and then read by `sh`, systemd or compose, and a `CR` at the end of a line breaks
all three quietly. This is not hypothetical: a tree exported from a Windows
checkout shipped the systemd unit templates as CRLF, because the rules covered
`*.sh` and `*.yaml` but not `*.service`. `install-agent-updater.sh` fills its
unit in with a `sed` anchored on `$`, that anchor stopped matching, `sed` exited
0 with nothing substituted, the installer printed success — and every node then
refused the panel's agent update with **`NODE_AGENT_UPDATE_REPO is not
configured on this host`**.

Note where that message comes from, because it points nowhere near the cause: it
is emitted by the **host-side** updater, while the agent reads the same setting
from `.env`, accepts the request and answers `202`. The panel shows a request
that succeeded and then quietly did nothing.

`.gitattributes` now pins `infra/** text eol=lf` and `scripts/** text eol=lf` —
path rules rather than more extensions, so a file added to those trees later is
covered — and `scripts/tests/deployed-files-eol.test.mjs` fails on any tracked
file there that `git check-attr` does not report as `eol=lf`. If you are working
from an export rather than a checkout, check before you blame the installer.

### Verify what the daemon holds, not what the command printed

`docker compose up -d` that prints `Running` changed nothing. Compose compares
the *resolved* configuration; if that is unchanged it leaves the container alone,
and whatever you edited on disk is not re-read. The output is not a lie — it is
telling you the container is running, which it is.

So say what you mean. `--force-recreate` when the change is one compose resolves
but might not notice; `restart` when it is a file behind a bind mount that the
entrypoint reads at start. Then check what the daemon actually holds rather than
trusting either command's output:

```sh
docker inspect --format '{{.Config.Image}}' amnezia-awg3     # the image in use now
docker inspect --format '{{.State.StartedAt}}' amnezia-awg3  # did it actually restart
docker exec amnezia-awg3 sh -lc 'awg show awg0 peers' | wc -l
```

The same applies to a rollout step exiting 0. Exit 0 is not evidence that a step
did anything — confirm the node appears in `amnezia-panel nodes` before calling a
rollout finished.

---

## Related documents

- [`INSTALL.md`](./INSTALL.md) — the install map, for a person or an agent.
- [`NODE-CONNECT.md`](./NODE-CONNECT.md) — connecting a node, the transport
  choice, shared hosts, and the node troubleshooting table.
- [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — the node install in full, and
  the agent-update mechanism.
- [`SMALL-HOSTS.md`](./SMALL-HOSTS.md) — every failure mode of a 512 MB - 1 GB
  host, with measured numbers.
- [`DEPLOY-UPDATE.md`](./DEPLOY-UPDATE.md) · [`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md)
  — updating the panel, and the Update button's host worker.
- [`CLI.md`](./CLI.md) — every command, panel and node.
