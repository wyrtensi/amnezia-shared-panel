# Connecting a VPN node

The concrete runbook for wiring one live VPN node (a server running the
node-agent / amnezia-api) to this control plane. For the full first-principles
install of a fresh host, see [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md); this
file is the short "connect an existing node" path.

Fill in the placeholders with your real values — the repo hardcodes none of them.

| Placeholder | What it is |
| --- | --- |
| `<NODE_HOST>` | The node's public IPv4 address. Use the address, not a DNS name — see [§1.1](#use-the-ip-address-not-a-dns-name). |
| `<NODE_NAME>` | The display name you give the node in the panel (ask the operator). |
| `<NODE_KEY>` | Your SSH private key for the node, e.g. `~/.ssh/<NODE_KEY>`. |

> **Secrets live in the git-ignored `secrets/` directory.** This document never
> prints key material — read the node-agent API key and the SSH key from there.

---

## 0. The scripted path

`scripts/add-node.sh` performs everything in this document — ensure 2 GiB of
swap, install Docker on the target host, deploy `infra/node`, ship the
node-agent image, open the supervised tunnel on the panel host, register the
node, reconcile it — in one idempotent command. Read the rest of this file to understand what it does, or
when a rollout needs to deviate from it.

```sh
cp scripts/add-node.env.example scripts/add-node.env   # once per deployment
$EDITOR scripts/add-node.env                           # panel address, SSH key, paths
scripts/add-node.sh --host <NODE_HOST> --name <NODE_NAME> --dry-run
scripts/add-node.sh --host <NODE_HOST> --name <NODE_NAME>
```

`scripts/add-node.env` is git-ignored and holds addresses, paths, and defaults —
never key material. The node-agent API key is generated **on the node**, and the
only place it is ever read is the panel host's own SSH hop during registration.

Requirements it assumes: root SSH from your workstation to both hosts, a
Linux/amd64 target with `/dev/net/tun`, and a panel host whose `control-api`
container has `PANEL_IDENTITY_SECRET` (it drives the admin API through the
bundled CLI, so no Cloudflare service token is needed).

Re-running is safe: an existing node-agent API key and `SERVER_ID` are never
regenerated, the tunnel keeps the port it already has, and an already-registered
node is left alone.

| Flag | Default | Effect |
| --- | --- | --- |
| `--host` | *(required)* | The node's SSH host. |
| `--name` | *(required)* | Display name in the panel; also names the tunnel unit. |
| `--region` | the name | `SERVER_REGION` on the node. |
| `--public-host` | `--host` | Address written into generated client configs. |
| `--max-peers` | `NODE_MAX_PEERS` | Capacity, 1..500. Also scales the preflight RAM gate. **Unset by default:** the script then derives it from the node's available memory (`MemAvailable * 500 / 358400`, capped at 500) and prints what it chose. |
| `--protocol` | `NODE_PROTOCOL` | Fallback protocol on the node record (`awg2`/`awg3`). |
| `--enabled-protocols` | `NODE_ENABLED_PROTOCOLS` | Comma list offered to the key wizard. |
| `--ssh-user` | `NODE_SSH_USER` | SSH user on the node. |
| `--config` | `scripts/add-node.env` | Alternate config file. |
| `--skip-register` | off | Deploy the node without registering it. |
| `--dry-run` | off | Report what would change, change nothing. |

---

## 1. What a node is

| Field | Value |
| --- | --- |
| Display name in panel | `<NODE_NAME>` |
| SSH | `root@<NODE_HOST>` |
| SSH key | `~/.ssh/<NODE_KEY>` |
| node-agent | listens **loopback only** on `127.0.0.1:4001` (never public) |
| Auth | `x-api-key` header (value in `secrets/`) |
| AWG 2.0 | container `amnezia-awg2`, UDP **51889**, subnet `10.89.0.0/22` |
| AWG 3.1 | container `amnezia-awg3`, UDP **51890**, subnet `10.90.0.0/22` |

Both protocols can be served; `GET /server` reports each. AWG 3.1 is the primary
protocol for new keys — 2.0 is kept only for peers that already use it.

### Use the IP address, not a DNS name

Set `SERVER_PUBLIC_HOST` in the node's `.env` — and `<NODE_HOST>` everywhere in
this runbook — to the node's **public IPv4 address**. Preflight still deploys a
node configured with a DNS name, but it prints
`NOTE: SERVER_PUBLIC_HOST is a DNS name …`, and that note is an instruction, not
a remark: **resolve the name on the server and use the address**.

Ask public DNS, and cross-check it against the address the node itself
egresses from — the two must agree before anything is written:

```sh
dig +short A <the name currently in SERVER_PUBLIC_HOST> @1.1.1.1   # what clients will get
curl -s https://api.ipify.org; echo                                # where this node actually is
```

**Do not use `getent`/`ping` on the node for this.** They consult `/etc/hosts`
first, and a host named after itself — every co-located panel+node — has a line
mapping its own FQDN to `127.0.0.1`. `getent ahostsv4 <own name>` then answers
`127.0.0.1`, and writing that into `SERVER_PUBLIC_HOST` would point every key at
the client's own loopback. Preflight rejects `127.0.0.1` outright, so this fails
the deploy rather than shipping broken keys — but the reject reads like a bug in
preflight instead of a wrong lookup, so use the two commands above.

If the two answers disagree, **stop**: either the record is stale, or it is
proxied (a Cloudflare-proxied name resolves to Cloudflare, which carries no UDP
at all and can never be a VPN endpoint). That is a misconfiguration to
understand, not an address to paste in.

Put that address in `.env` and redeploy. (On a node that has already issued keys,
read "What switching costs" at the end of this section first — the existing keys
carry the old value until they are reissued.) The reasons:

1. **The client resolves it, on its own network, before the tunnel exists.**
   The node-agent writes the value into the `Endpoint =` line of every generated
   `.conf` and into the `hostName` of the `vpn://` payload. That lookup happens on
   the very network AmneziaWG is built to get through — a DNS name gives it a
   plaintext query to block, poison or log; an address gives it nothing.
2. **It is baked into every issued key, and the panel never rewrites it.** The
   panel re-exports the node's payload as-is. A wrong value is fixed only by
   reissuing keys. (A DNS name would let the node's address move without
   reissuing — but a VPS keeps its address for the life of the box, and moving to
   another box means migrating the AWG state anyway.)
3. **The panel cannot see DNS failing.** The worker polls the node-agent over the
   management path, not the name clients use. A broken record looks like "node
   healthy, every client failing".
4. **Neither panel hostname is a VPN endpoint.** The Cloudflare-proxied panel
   name resolves to Cloudflare, which does not carry UDP. The direct
   (`direct.<panel domain>`, grey-cloud) name points at the panel server and
   works only until someone proxies it — never reuse it on a co-located node.
5. **IPv4 sidesteps A/AAAA ambiguity.** Preflight does not accept an IPv6
   literal today, so an IPv4 address is the only literal that deploys.

The panel-to-node path is a different matter: `http://host.docker.internal:<port>`
and `http://amnezia-node-agent:4001` are Docker-local names (resolved by
`extra_hosts: host-gateway` and compose DNS, never by public DNS) and are the
right `apiBaseUrl` values. The SSH tunnel's target (`root@<NODE_HOST>` in the unit
below) should be the address for reason 1: with a name, every `autossh`
reconnect depends on the panel host's resolver.

Where each value lives and what breaks with the other choice:

| Where | Expects | What breaks with the other choice |
| --- | --- | --- |
| `infra/node/.env` `SERVER_PUBLIC_HOST` → node-agent → `Endpoint =` and `hostName` in every key | **IPv4 address** (DNS name accepted with a `NOTE:`) | DNS name: reasons 1-5 above. Placeholders `203.0.113.10` / `vpn.example.com` are rejected by preflight. |
| `nodes.apiBaseUrl` (panel → node-agent) | Docker-local name: `http://host.docker.internal:<port>` or `http://amnezia-node-agent:4001` | A public DNS name here would be wrong for a loopback-only agent; the direct option below needs a hostname that matches its TLS certificate (an address needs an IP-SAN cert). |
| `root@<NODE_HOST>` in `panel-tunnel-<NODE_NAME>.service` | **IPv4 address** | DNS name: the tunnel cannot come back while the panel host's resolver is down; `known_hosts` is keyed by the name. |
| Panel public URL (Cloudflare-proxied) | hostname, orange cloud | Required for TLS + Access. Can never be a node endpoint. |
| `PANEL_PUBLIC_URL` / `direct.<panel domain>` | hostname, grey cloud | Required for the direct login. Not a node endpoint (reason 4). |

#### What switching costs

The two values above are switched at very different prices, so decide them
separately.

- **The tunnel target** (`root@<NODE_HOST>` in `panel-tunnel-<NODE_NAME>.service`)
  is free to switch: resolve the name, edit the one line, `daemon-reload`,
  restart the unit. No key is reissued, no client config changes, nobody
  reconnects. Do this as soon as you find a unit on a name.
- **`SERVER_PUBLIC_HOST`** is not free on a node that has already issued keys.
  Every `.conf` and `vpn://` link already in a user's hands carries the old
  value, and the panel cannot rewrite them — only reissuing the key does. Switch
  it freely on a new node; on a node in service, schedule it together with the
  reissue.

Both are worth doing. Only the second one needs a maintenance window.

To audit a running fleet rather than one node, the CLI answers both halves:
`nodes --hosts` classifies how the **panel** reaches each agent (`ip`,
`docker-local`, `dns`), `nodes` shows the address **clients** reach each node at,
and `keys --node=<id>` counts what a `SERVER_PUBLIC_HOST` switch would have to
reissue.

The node cards in the admin panel show whatever `SERVER_PUBLIC_HOST` holds;
following this section is what makes that display an address.

### Shared hosts — do not disturb other tenants

If the box also runs unrelated services (another VPN, an Outline/`shadowbox`
server, `watchtower`, a legacy `awg-quick@…` unit, etc.), those are **not** ours
and must never be stopped, recreated, pruned, or reconfigured. AWG 3.1 is rolled
out **additively** — never stop or recreate a live `amnezia-awg2` container that
carries existing peers.

Disk cleanup is limited to rotated logs (`journalctl --vacuum-size`) and
dangling/obsolete unused images. **Never** `docker system prune -a` or prune
volumes on a shared host.

**A foreign container can hold the name compose wants.** A container created
outside compose carries no `com.docker.compose.*` labels, and if it is named
`amnezia-awg2` or `amnezia-awg3` a plain `docker compose up -d` fails on a name
conflict — including a single-service command, because `node-agent` declares
`depends_on`. Check before assuming the container is ours:

```sh
docker inspect <name> --format '{{index .Config.Labels "com.docker.compose.project"}}'
```

An empty answer means it is not ours. Do **not** remove or rename it to unblock
the deploy — that kills a live service belonging to someone else, possibly with
peers connected. Change only our own services, and skip the dependency graph so
compose never touches the foreign one:

```sh
docker compose up -d --no-deps node-agent
```

Back up `state/`, `secrets/` and `.env` first if the node has no `scripts/deploy.sh`
to take a pre-deploy backup for you (nodes provisioned by `scripts/add-node.sh`
ship a reduced layout and have neither `deploy.sh` nor `preflight.sh`).

### Installing alongside an existing, unrelated Amnezia install

A node can be installed on a host that **already** runs a separate, unrelated
Amnezia (or other VPN) install **without disrupting it**, because this stack uses
its **own** container names (`amnezia-awg2` / `amnezia-awg3` /
`amnezia-node-agent`), its **own** UDP ports, its **own** Docker network, and its
**own** Compose project (`amnezia-node`). Preflight refuses to adopt a container
owned by another Compose project.

Always do **read-only recon first** and pick ports that do not clash with whatever
is already there:

```sh
docker ps --format '{{.Names}}\t{{.Image}}\t{{.Ports}}'   # existing containers/ports
ss -H -lun | awk '{print $5}'                             # UDP ports already bound
```

If the defaults (`51889`/`51890` UDP, `4001` TCP loopback) collide with an
existing install, choose free ports before deploying — never re-port the other
tenant's containers.

### Getting the node-agent image onto a host

A node never builds the agent: the compose file sets `pull_policy: never` and
`NODE_AGENT_IMAGE` must be an immutable reference. Building it on the node is
not merely discouraged — a three-stage Node build with `npm ci` does not fit on
a 1 GB box that also has to pass preflight's free-disk gate.

#### Preferred: pull a published digest

Tagging `node-agent-v<version>` runs
[`release-node-agent.yml`](../.github/workflows/release-node-agent.yml), which
builds on a GitHub runner and pushes to
`ghcr.io/<owner>/<repo>/node-agent`. The run summary prints the exact line to
paste:

```
NODE_AGENT_IMAGE=ghcr.io/<owner>/<repo>/node-agent@sha256:<digest>
```

Put that in the node's `.env` and run `sh scripts/deploy.sh`. `deploy.sh` pulls
any `…@sha256:…` reference before preflight checks the image is present, so
nothing else is needed on the host — and because the reference is a digest,
preflight's "immutable image" rule is satisfied by construction.

There is deliberately **no `latest` tag** for this image. A node pins its agent
by digest and preflight fails a deploy that names a mutable tag; publishing one
would only invite the mistake that rule exists to prevent.

#### Fallback: build elsewhere and ship the tarball

For an air-gapped node, or before the image is published, build on a host with
headroom and ship it with `docker save` piped into a remote `docker load`:

```sh
docker save "$NODE_AGENT_IMAGE" | ssh -i ~/.ssh/<NODE_KEY> root@<NODE_HOST> 'docker load'
```

> **Take the image ID from the receiving host, not the sending one.** Newer
> Docker engines re-encode the image config on load, so `docker load` prints a
> *different* `sha256:` than the source host has. Set that host's
> `NODE_AGENT_IMAGE` to the ID `docker load` reported **there** — pinning the
> source ID makes preflight fail with the image "not present locally".

The tarball path is also why the agent used to fall behind: it only happens
when somebody remembers to do it, so a change merged and released to the panel
could reach no node at all, with nothing anywhere reporting that the agent was
old. Prefer the published digest.

#### After the first deploy: the button

Once a node runs a published digest **of node-agent 1.1.9 or newer**, later
agent versions can be installed from the panel instead of over SSH. It is
opt-in per host:

```sh
sudo NODE_AGENT_UPDATE_REPO=ghcr.io/<owner>/<repo>/node-agent   bash scripts/install-agent-updater.sh
```

The version floor is not a formality: on 1.1.3 through 1.1.8 both
`/server/update` routes answer `500` because the agent's container could not
construct the service behind them, and the panel shows nothing at all when that
happens — the job fails, the card's state stays where it was and
`node-agent-log` shows nothing new. Get the node to 1.1.9 over SSH first
("Getting the node-agent image onto a host" above); the button works from
there on.

The swap runs on the host (`scripts/agent-update.sh`, a port of the panel's own
`panel-updater`), recreates **only** the agent container with `--no-deps` so no
tunnel drops, and rolls back to the previous digest if the new agent fails its
health gate. On a shared host that `--no-deps` matters twice over — see "Shared
hosts" above. Details and the failure modes are in
[`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md), "Updating a node's agent from the
panel".

See [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) for building the image.

---

## 2. Reaching the node from the panel

The node-agent is bound to loopback on the server, so the control plane reaches
it in one of these ways:

**Co-located (panel + node on one host) — attach to the node's Docker network.**
When the panel and the node share a host, add a Compose override that attaches
`control-api` + `worker` to the node's Docker network, then register the node with
**`apiBaseUrl: http://amnezia-node-agent:4001`** — the worker reaches the agent
container by name, no tunnel needed. (Alternatively use the panel's
`host.docker.internal` route: `apiBaseUrl: http://host.docker.internal:4001`.) See
[`ROLLOUT.md` §5](./ROLLOUT.md#5-co-location-networking).

When the panel and the node are on **separate** hosts, the agent is loopback-only
by default, so reach it over an approved private transport:

**A. SSH tunnel (recommended — keeps the agent private and encrypts the hop).**
The worker runs in Docker and reaches the host via `host.docker.internal`, which
resolves to the Docker bridge gateway (typically `172.17.0.1`). Bind the tunnel on
**that gateway IP** — a private address, so the forwarded port is *not* exposed on
the public internet — using one local port per remote node (e.g. `4105`, `4106`, …).

Use a **dedicated** key, never your personal SSH key: generate it on the panel host
and add its public key to each node's `authorized_keys` (keep the private key in
`secrets/` too, and never publish it).

```bash
# on the panel host, once:
ssh-keygen -t ed25519 -f /root/.ssh/panel_nodes_key -N '' -C panel-to-nodes
#   then append /root/.ssh/panel_nodes_key.pub to each node's ~/.ssh/authorized_keys

# one persistent tunnel per node, as a systemd unit:
cat >/etc/systemd/system/panel-tunnel-<NODE_NAME>.service <<'UNIT'
[Unit]
Description=Panel -> node tunnel (<NODE_NAME>)
After=network-online.target docker.service
Wants=network-online.target

[Service]
# Without this, autossh gives up FOR GOOD if the first connection dies within
# 30 s — which is exactly what happens when the node is down while the panel
# host boots, leaving a tunnel that never comes back on its own.
Environment=AUTOSSH_GATETIME=0
ExecStart=/usr/bin/autossh -M 0 -N \
  -o ServerAliveInterval=30 -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes \
  -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/root/.ssh/known_hosts \
  -i /root/.ssh/panel_nodes_key \
  -L 172.17.0.1:4105:127.0.0.1:4001 root@<NODE_HOST>
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now panel-tunnel-<NODE_NAME>
```

Two layers of recovery, and both matter: `autossh` respawns `ssh` when the link
dies (`ServerAliveInterval` × `ServerAliveCountMax` ≈ 90 s to notice a black-holed
connection), and `Restart=always` brings `autossh` itself back if it is killed.
`enable` is what restores the tunnel after a reboot of the panel host; `After=`
`docker.service` matters because the forward binds the `docker0` address, which
does not exist until Docker is up. `<NODE_HOST>` is the node's IPv4 address here
for the same reason it is in `SERVER_PUBLIC_HOST` — a reconnecting tunnel must
not depend on a resolver.

Register that node with **`apiBaseUrl: http://host.docker.internal:4105`**, and
verify the panel reaches it:

```bash
docker compose -f infra/prod/compose.yaml exec control-api \
  wget -qO- http://host.docker.internal:4105/healthz     # -> {"ok":true}
```

- If a tunnel drops, `autossh` reconnects; meanwhile the panel shows that node
  unhealthy with `lastError: "fetch failed"` until the next successful poll.
  VPN clients are unaffected — they reach the node's UDP port directly, and the
  tunnel only carries the panel's management calls to the node-agent.
- While the node is unreachable, `autossh` retries in a widening loop (a few
  attempts in the first second, then seconds apart). That is expected; check it
  with `journalctl -u panel-tunnel-<NODE_NAME> -f`.

**B. Directly exposed agent (simpler URL, needs TLS).** If you publish the
node-agent on the server behind TLS + the `x-api-key` (e.g. via a reverse proxy),
the panel connects straight to `https://<NODE_HOST>:<PORT>` — no tunnel. Only do
this with TLS and a strong key; never expose the plain loopback port publicly.

Quick check the agent answers (from wherever the panel will reach it):

```bash
curl -s -H "x-api-key: $NODE_AGENT_KEY" http://127.0.0.1:4001/server | head -c 400
```

You should see JSON listing the `amnezia-awg2` / `amnezia-awg3` containers.

---

## 3. Registering the node in the panel

Once the agent is reachable, register the node so the worker starts provisioning
and polling telemetry. Use the admin UI (**VPN-ноды → Добавить ноду**) or
`POST /api/admin/nodes`:

| Field | Value |
| --- | --- |
| `name` | `<NODE_NAME>` |
| `apiBaseUrl` | `http://host.docker.internal:<tunnel port>` (tunnel, e.g. `4105`) or `https://<node hostname>:<PORT>` (direct; the hostname must match the TLS certificate) |
| `apiKey` | *(from `secrets/`)* |
| `protocol` | `awg3` (primary; the node still serves awg2 peers) |
| `maxPeers` | node capacity (e.g. `250`) |

`supportedProtocols`, health, capabilities and the node's public address are
filled in automatically by the worker's telemetry sync after the first
successful poll. The address is the agent's own `SERVER_PUBLIC_HOST`
(`publicHost`) plus the IPv4 the panel resolved it to (`publicIp`); an agent
image built before this field was added leaves both empty and the admin card
says so until the image is rebuilt and reloaded (see "Shipping the node-agent
image" above). When `lastHealthAt` starts advancing and `lastError` clears, the
link is live.

The name is resolved once, when the panel first learns it or when the node
starts reporting a different host — a server's public address does not change
under it, so there is no periodic lookup and `publicIpResolvedAt` records when
the address was learned rather than how fresh it is. Only `A` records are used:
the endpoint line in a client config is written as `host:port` with no
bracketing, so an IPv6 address would produce a config no client can parse, and
a host with only an `AAAA` record is shown without an IP rather than with an
unusable one.

Admins always see the address on the node card. Ordinary users see it on their
dashboard only when the global portal policy's `showNodeAddress` is turned on
(admin → policy, or `amnezia-panel policy-set --showNodeAddress=true`); it is
off by default.

---

## 4. Verify end-to-end

1. **Node healthy** — admin → *VPN-ноды*: `<NODE_NAME>` shows green with a recent
   sync and both protocols under supported.
2. **Create a key** — admin → *Пользователи* → pick a user → **Ключ**, or the
   employee wizard at `/`. Protocol defaults to AWG 3.1.
3. **Key goes active** — it transitions `provisioning → active` within a poll
   cycle; export the `.conf`/QR and import it in an Amnezia client.
4. **Telemetry** — once the client connects, the key's online dot turns green and
   traffic counters increase.

---

## 5. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| Node unhealthy, `lastError: "fetch failed"` | SSH tunnel down / agent unreachable | Re-open the tunnel (§2); worker recovers on the next poll. |
| `401` from the node-agent | `apiKey` mismatch | Re-copy the key from `secrets/` into the node record. |
| Key stuck in `provisioning` | Worker can't reach the agent, or outbox stalled | Confirm the tunnel, then check worker logs for the `vpn-key.provision` job. |
| `host.docker.internal` unresolved | Tunnel bound to `127.0.0.1` only | Re-open with `-L 0.0.0.0:4001:...` (§2). |
| Node healthy in the panel, no client can connect | `SERVER_PUBLIC_HOST` is a DNS name the client's network blocks or poisons, or it resolves to Cloudflare | Set it to the node's public IPv4 address (§1.1), redeploy, reissue the keys. |
| AWG container restarts, logs `can't open /usr/local/libexec/awgN-entrypoint.sh: Permission denied` | `infra/node` was copied with a non-root uid (a plain `tar -c`, `scp` from a workstation), and the entrypoints are mode 0700 | `chown -R root:root <node dir>` on the node, then re-deploy. Copy with `tar --owner=0 --group=0 --numeric-owner` to avoid it. |
| Preflight fails `state file permissions must be 0600` | The node-agent rewrites `awg0.conf` / `clientsTable` with the default umask after a client changes, so they come back 0644 | `find <node dir>/state -type f -exec chmod 600 {} +`, then re-deploy. Access is still gated by the 0700 `state/` directory, so this blocks updates rather than exposing anything. |
| Preflight fails with the node-agent image "not present locally" | `NODE_AGENT_IMAGE` was pinned to the *sending* host's ID after a `docker save`/`load` | Re-read the ID from `docker load`'s output **on the node** (§2). |
| Preflight rejects a valid API key: "must contain only printable non-space ASCII characters" | On a memory-constrained node, `grep -E '…{32,4096}'` was OOM-killed and its non-zero exit read as a malformed key (`dmesg`: `Out of memory: Killed process (grep)`) | Fixed in `preflight.sh` — the check no longer uses bounded repetition. Avoid `{n,m}` over a character class in any node-side shell check: it cost ~280 MiB of RSS versus ~2 MiB for the linear equivalent. |
| Preflight fails the RAM gate on a re-deploy of a small node | `MemAvailable` is measured **while the stack is running**, so on a tiny host it hovers near the required floor | `docker compose down` first, or size the host up. Adding swap does not help — the gate reads `MemAvailable`. |
| A rollout reports success but the node never appears | A step that pipes a script into a remote `bash` also ran `ssh` inside it; the inner `ssh` drained the rest of the heredoc, so the remaining commands never executed and `bash` exited 0 at EOF | Use `ssh -n` inside any block fed to a remote shell on stdin. Never treat exit 0 from registration as proof — confirm with `nodes`. |
| The "update agent" button (or `node-agent-update`) does nothing: the card's state never moves and `node-agent-log` shows nothing new | node-agent 1.1.3–1.1.8 answer `500` on both `/server/update` routes (the container could not construct the service). The worker's job fails on the POST, so the node never enters `requested` and nothing is ever written back to the card; the reason lands only in `job_outbox.last_error` | Update that node to 1.1.9 over SSH (pin `NODE_AGENT_IMAGE` to the 1.1.9 digest, `sh scripts/deploy.sh`). The button works for every version after it. |
| `node-agent-log` says `NODE_AGENT_UPDATE_REPO is not configured on this host`, although `install-agent-updater.sh` ran cleanly | The systemd units were checked out with CRLF (a `git archive` from a Windows checkout, before `.gitattributes` pinned `infra/**` to LF), so the installer's `sed 's#^Environment=NODE_AGENT_UPDATE_REPO=$#…#'` anchor did not match and the unit kept an empty value. The agent reads the same setting from `.env`, so it still accepts the request and answers `202` — the host-side updater is what fails | Re-copy `infra/` from a checkout with the current `.gitattributes`, or `sed -i 's/\r$//'` the unit and `systemctl daemon-reload`, then re-run the installer. |
| Two nodes with the same name in `nodes` | Repeated runs of `add-node.sh` before it recognised an already-registered node again; each run registered a second row | Remove the extra one with `node-remove`. |

See [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) for the node side (agent logs,
`/server` shape, backup/rollback).
