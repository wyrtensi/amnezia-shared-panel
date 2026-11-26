# Operating the servers, day to day

Two things live here, and nothing else.

**A map.** `docs/` holds more than a dozen files and their titles overlap; at 3am you
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
| Install a VPN node on a bare host | [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) Part A; `scripts/add-node.sh` does the whole rollout in one command ([`NODE-CONNECT.md` §0](./NODE-CONNECT.md#0-the-scripted-path)). It leaves out the host-side updater, without which that node can never be updated from the panel — run `install-agent-updater.sh` after it |
| Connect an already-running node to the panel | [`NODE-CONNECT.md`](./NODE-CONNECT.md) |
| Raise the panel and put a login in front of it | [`HOSTING.md`](./HOSTING.md) for the shape, [`CLOUDFLARE-SETUP.md`](./CLOUDFLARE-SETUP.md) for the clicks |
| Share :443 with a site or a VPN transport already on it | [`HOSTING.md` §4.1](./HOSTING.md) — the SNI router, and the three properties that break it |
| Keep an operator hostname out of public view | [`HOSTING.md` §4.2](./HOSTING.md) — Certificate Transparency is the leak, not search engines |
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
| Configure split-tunneling (`ru_blacklist` E-Core), `global_route_overrides`, `RULE_EXTRA_*` feeds, or Steam split-routing | [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md#route-profiles-and-rule-feeds) |
| Toggle the per-node AWG 3.1 IPv6 active-reject ULA stub (`fd6b:7c2e:4a91:9f::/64`) | [**Per-node AWG 3.1 IPv6 active-reject stub**](#per-node-awg-31-ipv6-active-reject-stub-ula--prohibit-20003) below, [`CLI.md`](./CLI.md) (`node-ipv6-stub`), and [`IPV6-DESIGN.md`](./IPV6-DESIGN.md) |
| Configure multi-exit routing, Exit IPs, and Entry → Exit variants | [**Multi-exit routing (`egress-daemon`)**](#multi-exit-routing-egress-daemon) below and [`CLI.md`](./CLI.md) (`node-egress*`, `node-exit-*`, `key-reassign-endpoint`) |
| Deploy, audit, or remove the temporary `containerd-shim-runc-v2` override (`ttrpc#241`) | [`TEMPORARY-SHIM-OVERRIDE.md`](./TEMPORARY-SHIM-OVERRIDE.md) |
| Deploy, verify, activate, or roll back optional AWG 3.1 node bridges | [`runbooks/AWG-BRIDGES.md`](./runbooks/AWG-BRIDGES.md) and [`infra/bridge/README.md`](../infra/bridge/README.md) |
| Set up external reachability probing and Telegram alerts / status widget | [`REACHABILITY-PROBE.md`](./REACHABILITY-PROBE.md) |

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

`awg3-geometry.sh` runs **once**, at first initialization. Rerolling the
geometry would invalidate keys already issued from that node.
`AWG3_DISABLE_COOKIES` seeds the saved config on first start. Changing that
setting on an existing node requires an edit to `awg0.conf`.

`AWG3_TUNNEL_MTU` defaults to **1280** and sets the live AWG 3.1 interface
on every start. It also supplies the sizing input on first initialization.
The container must be recreated to pick up changes to the Compose environment.
Keep the existing state mount when changing MTU. Existing AWG credentials
remain valid. The Control API includes MTU 1280 in AWG 3.1 exports for both
new and existing keys. Clients with an older imported config must re-import an
updated export or change the MTU in the app for the client-side value to change.

When editing `awg0.conf`, place interface directives inside `[Interface]`.

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

### AWG 3.1 client parameters

`Jc`, `Jmin`, `Jmax` and the order of `I1`-`I3` are sent by the client alone, and
the server does not check them. The panel therefore gives every AWG 3.1 key its
own set instead of the node's, with nothing written to `awg0.conf`:

- `vpn_keys.awg_client_profile` holds the set (`Jc` 3-10, `Jmin` 40-100,
  `Jmax - Jmin` 30-200, an index into the orders of the populated `I1`-`I3`).
  A new `awg3` key gets one at creation. A key created before this has none
  and exports the node's own values until its owner refreshes it.
- Every export applies it over the encrypted artifact the node issued, in all
  three copies inside the `vpn://` payload. The artifact itself is never
  rewritten, so an older panel build still exports the node's values.
- It applies only when the artifact says `protocol_version: "3.1"`. A 2.0
  artifact, including an AWG3 node's 2.0 fallback, exports as before.
- **Refresh config** on the key card (`GET` then `POST`
  `/api/keys/:id/config-refresh`) draws a new set with a different `Jc`. It is
  owner-only, needs config redownload in the policy, and is audited as
  `vpn_key.config_profile_refreshed` with the revision only. No node call, no
  outbox job, same peer and address: the old connection keeps working until
  the owner imports the new config. The dialog says so, and that previously imported files keep their old endpoint (a bridge activation or return to Direct reaches a client only through a refreshed, re-imported file).

The `H1`-`H4`, `S1`-`S4`, header protection and trailers stay the node's: those
the server does check, and a key with a changed `H1` gets no handshake.

Administrators can open **Parameters** for a key in **Users** or for a node or
address in the node's configuration dialog. The view shows the values used
for export alongside any differing values originally issued by the node.
It exposes only the allowed Interface fields. If a node has no usable probe
service key, its view returns `404 SAMPLE_KEY_NOT_FOUND`.

Profile and MTU each follow the order key → user device rule → user → address
device rule → address → node. Each takes the first value set. The probe
measures its own service key using only the address and node settings. Use
**Pin for the user** or **Pin for the user's devices** to copy a key's resolved
profile settings and MTU to its owner. Draws remain per key for randomized
profiles. Service-account and AWG 2.0 keys cannot be pinned. A device pin also
requires a specified device type. See [AWG generator settings](AWG-GENERATOR.md#inspecting-and-pinning-parameters).

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

### Bridge management tunnels

A bridge host's bridge-agent is reached the same way: one `autossh` unit per
bridge on the panel host, named `panel-tunnel-bridge-<bridge-id>.service`,
forwarding a local port to the agent's `127.0.0.1:7600`. It is created by
`scripts/add-bridge-tunnel.sh` (see [`infra/bridge/README.md`](../infra/bridge/README.md)),
allocates from the same pool as the node tunnels (same `-L` scan, same base), and
pins the bridge's SSH host key instead of trusting the first one it sees. The
panel's record for the bridge is `http://host.docker.internal:<port>`, so the
same three checks above apply with the bridge unit name. Stopping a bridge tunnel
makes the bridge read `down` at its next poll (a `down` bridge stays `down`; only a
bridge last reported `ok` turns `stale`, once its observation is older than the
stale window) in the admin screens; active routes and the frps forwarding keep
working, and the route evidence reads Unknown instead of a stale "online".

**Bridge polls share the worker's one outbox lane.** The worker runs one outbox
job at a time, and the bridge-agent poll (`bridge_agent.poll`, one job per
enrolled bridge, armed every 60 s) is one of those jobs, next to key
provisioning. Each poll has a 5 s deadline, so a hung agent costs up to 5 s of
that lane per poll, and several hung bridges add up. If provisioning slows down
while a bridge shows `down`, fix or disable that bridge first.
Bridge polling only runs while `VPN_BRIDGE_JOBS_ENABLED=true`.

**Bridge-agent updates.** An update request (`bridge-agent-update --confirm`, or the
Update agent button on the Bridges tab) stores one operation per bridge and queues a
`bridge_agent.update` job. The job sends the intent (with `notAfter`, the panel's pickup
deadline, request time + 120 s) to the agent once and ends; the bridge's next polls follow the
operation (`GET /v1/update?operationId=`), so a poll costs one more request while an update is
outstanding. The agent's capabilities (`/v1/identity`) are re-read when unknown, older than
10 minutes, or while an update is outstanding; a failed read is logged with a bounded code.
States: `queued, sent, acknowledged, running` (outstanding), `succeeded, rolled_back,
rollback_failed, failed, pickup_timeout` (terminal). An operation holds the bridge's slot until a
reachable agent confirms its fate: a terminal result, `expired` (recorded as `pickup_timeout`), or
that it does not know the operation (`failed UPDATE_UNKNOWN_TO_AGENT`). Observations never free
the slot or trigger a retry: `contactLostSince` (no usable answer, at any stage, including before
pickup: the host may be replacing the agent) and `acknowledgementOverdueSince` (the agent
answers but still reports the request unstarted past `notAfter`). A delivery whose POST got no
usable answer is asked about, and re-sent only if the agent confirms it never saw it. A queued
operation whose POST was never attempted and whose job is gone closes as
`failed UPDATE_NEVER_SENT`. If an overdue request needs help, check
`systemctl status amnezia-bridge-agent-update.path` on the bridge host; once the agent reports
`expired` the operation ends and you can request again.
On the bridge host the agent only records the intent in `/var/lib/amnezia-bridge/update/requests`;
the systemd updater (`bridge-agent-update.sh`, installed by `install-bridge.sh`) re-validates it,
pulls the digest, recreates only the `bridge-agent` service with `--no-deps` (frps is never
touched), and accepts it only after the digest, bridge identity and an authenticated status with
frps reachable check out; otherwise it restores the pinned image and checks that too
(`rolled_back` / `rollback_failed`). Results carry fixed codes; details are in
`journalctl -u amnezia-bridge-agent-update.service`. See `infra/bridge/README.md`
("bridge-agent updates").

*A bridge that stays unreachable while its update slot is held.* The slot is deliberately not
freed on silence, because the host may still apply the update. Restore contact: check the
`panel-tunnel-bridge-<id>` unit and the bridge host's `bridge-agent` container, and if the agent
cannot be brought back, reinstall it with `install-bridge.sh` (same bridge id, same image from the
pin file) or re-enroll it (`bridge-enroll`). As soon as an agent answers, the next poll reads the
operation: the real state, or a 404 (`failed UPDATE_UNKNOWN_TO_AGENT`), or `expired`, ends the
operation and frees the slot. A request is never closed by the panel on its own once its POST was
attempted; one past `notAfter` that was never sent closes as `failed UPDATE_NEVER_SENT`.

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

## Per-node AWG 3.1 IPv6 active-reject stub (ULA + `prohibit 2000::/3`)

On IPv4-only AWG 3.1 nodes, full-tunnel configs include `AllowedIPs = 0.0.0.0/0, ::/0`
so clients do not leak IPv6 outside the tunnel, while the tunnel itself has no IPv6
address — which can cause 10–30 second IPv6 stalls (Happy Eyeballs / QUIC blackhole)
on mobile Wi-Fi networks that advertise global IPv6.

Each AWG 3.1 node card in `/admin/nodes` (and `amnezia-panel node-ipv6-stub <id>`)
provides a per-node **IPv6 Reject (ULA)** switch backed by `PUT /api/admin/nodes/:id/ipv6-reject-stub`:

- **Dedicated subnet:** defaults to `fd6b:7c2e:4a91:9f::/64` (separate from the
  future full-IPv6 NAT66 subnet `fd6b:7c2e:4a91:90::/64`, so enabling it now does
  not collide with a future dual-stack migration). Peer ULAs are derived
  deterministically from each peer's AWG 3.1 IPv4 lease (`10.90.0.N` → `::N/128`).
- **Prerequisite:** the node must run the updated `node-agent` and an `amnezia-awg3`
  container whose network namespace has `net.ipv6.conf.{all,default}.disable_ipv6=0`
  and `net.ipv6.conf.all.forwarding=1`. `infra/node/compose.yaml` declares those
  sysctls for future recreates, and starting with `node-agent` `1.1.22` the
  host-side `scripts/agent-update.sh` also reconciles untouched `scripts/awg3-entrypoint.sh`
  / `scripts/agent-update.sh` and applies those IPv6 sysctls live inside the running
  `amnezia-awg3` netns via `nsenter` with zero tunnel downtime and no AWG container
  restart. Existing containers without those sysctls report `unsupported`
  (`ipv6_forwarding_disabled`) until `agent-update.sh` applies them live (or the
  operator recreates `awg3`).
- **Smooth transitions (zero IPv4 drop):**
  - **OFF → ON:** installs `<prefix>::1/64` on `awg0` and `ip -6 route replace prohibit 2000::/3`,
    updates active peers in `awg0.conf` via `awg syncconf`, and persists `/opt/amnezia/awg/ipv6-reject-stub.env`
    (mode `0600`, restored fail-safely on container restart). Existing IPv4-only keys keep working
    untouched; iOS/Android `vpn://` and all `.conf`/`qr-conf` exports immediately project the peer ULA,
    while desktop `vpn://` stays strictly IPv4-only.
  - **ON → OFF:** reverts active peers in `awg0.conf` back to `<v4>/32` via `awg syncconf`,
    deletes `prohibit 2000::/3` and `<prefix>::1/64`, and writes `ENABLED=0`. Already-imported
    mobile keys continue working over IPv4 without urgent key reissue; all subsequent exports
    return clean IPv4-only configs.

---

## Multi-exit routing (`egress-daemon`)

Nodes running `amnezia-egressd` (`services/egress-daemon`) alongside `node-agent`
support per-Entry-IP variant routing across multiple public Exit IPs on the same
host (`routed` mode) while defaulting to backwards-compatible `masquerade`:

- **Modes & safety guards:** `masquerade` uses standard container NAT; `routed`
  installs dedicated Linux routing tables (`200..219`), per-peer `ip rule`
  mappings by `tunnel_ipv4`, `SNAT --to-source` rules, per-exit DNS DNAT
  (`amneziaDnsDnat` / `enforceDnsDnat`), default-on outbound SMTP port `25`
  blocking (`egressBlockSmtp`, configurable per node in UI and CLI while keeping
  mail-client ports `465`/`587` open), and default-on private-subnet isolation
  (`egressIsolatePrivate`, both enforced on the host in `routed` mode).
- **Bundled `amnezia-egressd` lifecycle & updates:** `amnezia-egressd` is
  compiled into the `node-agent` image (`/opt/node-agent/bin/amnezia-egressd` +
  `systemd/amnezia-egressd.service`), runs on the host as a separate root
  systemd service (`MemoryMax=32M`), and is driven by unprivileged `node-agent`
  (`uid=10001`, `cap_drop: ALL`) over `/run/amnezia-egress/egressd.sock`
  (`10001:0`, `0600`). In-panel agent updates (`agent-update.sh`) upgrade or
  bootstrap `amnezia-egressd` together with `node-agent`, verify `/v1/health`
  over the Unix socket, preserve active kernel routes across daemon restart
  (zero tunnel drop), and roll back both components on failure. Note: legacy
  hosts whose `compose.yaml` predates `/run/amnezia-egress` skip automatic
  compose replacement and require reconciling `compose.yaml` or running
  `scripts/install-host-services.sh` so `node-agent` can reach the socket.
- **Endpoint variants:** each `(node_id, address, egress_ip_id)` variant keeps
  its own probe verdict and client DNS pair; moving an AWG 3.1 key between
  variants on the same node (`amnezia-panel key-reassign-endpoint`) keeps
  its WireGuard keypair and `tunnel_ipv4` unchanged (zero tunnel drop).
- **Drift recovery & DB restore:** inspect node state with
  `amnezia-panel node-egress <id>`. When host `observedMode` differs from DB
  `egressMode` (`modeDrift`, e.g., after restoring an older database dump),
  either adopt host reality (`amnezia-panel node-egress-adopt <id>`) or
  explicitly push the desired mode (`amnezia-panel node-egress-mode <id> <masquerade|routed>`).

### Plain-language glossary (modes, terms & knobs)

| Term / setting | What it actually does on the server & for clients |
| --- | --- |
| **Masquerade (`masquerade`)** | Default single-exit mode. All VPN traffic leaves through the node's primary IP using NAT (`MASQUERADE`) inside the `amnezia-awg3` container. `amnezia-egressd` keeps no nftables rules or custom routing tables active. |
| **Routed (`routed`)** | Multi-exit host routing mode. `amnezia-awg3` forwards packets onto the `br-awg-egress` bridge (`172.30.90.0/29`), where host `amnezia-egressd` maps each peer's inner `10.90.x.y/32` IP to its assigned Exit IP via Linux policy routing (`ip rule` + `fwmark` + routing tables `200..219`) and `SNAT --to-source`. |
| **Entry IP vs Exit IP vs Variant (`Entry → Exit`)** | **Entry IP** is the endpoint address clients connect to; **Exit IP** is the public IP websites see; a **Server variant** binds one Entry to one Exit (one Entry IP can serve multiple variants with different Exit IPs). |
| **`amnezia-egressd`** | Lightweight root systemd service (`MemoryMax=32M`) bundled inside the `node-agent` image and controlled over `/run/amnezia-egress/egressd.sock` (`10001:0`, `0600`). Upgraded and rolled back atomically with `node-agent` without dropping VPN tunnels. |
| **Routing tables (`200..219`)** | Isolated Linux routing tables (one per Exit IP, auto-assigned or pinned manually) so each exit leaves via the right NIC and gateway without altering the host `main` table or breaking SSH / host relays. |
| **Block outbound SMTP (`egressBlockSmtp`)** | On by default; enforced on the host in `routed` mode (or saved in DB/state if toggled in `masquerade`). Drops outbound TCP port `25` only, protecting exit IPs from spam abuse tickets and blocklists while keeping mail-client ports `465`/`587` and webmail working. Editable in UI and CLI (`node-update --egress-block-smtp=`). |
| **Isolate RFC1918 (`egressIsolatePrivate`)** | On by default; enforced in `routed` mode. Blocks VPN clients from reaching private/internal ranges (`10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.0.0/16`, `100.64.0.0/10`, `127.0.0.0/8`), including VPS LANs and cloud metadata endpoints. |
| **DNS DNAT (`amneziaDnsDnat`, `enforceDnsDnat`)** | `amneziaDnsDnat` (on by default) redirects queries sent to AmneziaVPN's built-in `172.29.172.254:53` to the exit's `dnsPrimary` via its Exit IP. `enforceDnsDnat` (off by default) intercepts *all* client `:53` UDP/TCP DNS traffic (overrides custom DNS set on the device). |
| **Allow as Entry (`allowAsEntry`)** | By default the panel warns when an Exit IP matches an Entry IP (to avoid correlating inbound and outbound IPs). Enable it when intentionally reusing the same IP for both Entry and Exit. |
| **Hot-swap IP (`node-exit-swap`)** | Replaces a burned/blocked Exit IP in place (updates `SNAT` and flushes conntrack) without re-issuing client configs; omitting `--interface`/`--gateway` clears stale overrides for auto-discovery. |
| **Mode drift (`modeDrift` / `node-egress-adopt`)** | Shown when DB `egressMode` disagrees with live host `observedMode` (for instance after a DB restore). Sync leaves live traffic intact until you either adopt the host mode or push the desired DB mode. |

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
- [`REACHABILITY-PROBE.md`](./REACHABILITY-PROBE.md) — external reachability
  probe, Telegram alerts, and pinned status widget.
- [`runbooks/AWG-BRIDGES.md`](./runbooks/AWG-BRIDGES.md) — optional AWG 3.1
  node bridges, `useBridge` opt-in policy, and rollback preflight.
- [`IPV6-DESIGN.md`](./IPV6-DESIGN.md) — shipped IPv6 hygiene (E-Core dual-stack
  routes + active-reject stub) and future full NAT66 / IPv6 endpoint draft.
- [`CLI.md`](./CLI.md) — every command, panel and node.
