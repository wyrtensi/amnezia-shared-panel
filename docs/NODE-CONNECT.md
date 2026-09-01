# Connecting a VPN node

The concrete runbook for wiring one live VPN node (a server running the
node-agent / amnezia-api) to this control plane. For the full first-principles
install of a fresh host, see [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md); this
file is the short "connect an existing node" path.

Fill in the placeholders with your real values — the repo hardcodes none of them.

| Placeholder | What it is |
| --- | --- |
| `<NODE_HOST>` | The node's SSH host (IP or hostname). |
| `<NODE_NAME>` | The display name you give the node in the panel (ask the operator). |
| `<NODE_KEY>` | Your SSH private key for the node, e.g. `~/.ssh/<NODE_KEY>`. |

> **Secrets live in the git-ignored `secrets/` directory.** This document never
> prints key material — read the node-agent API key and the SSH key from there.

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

### Shared hosts — do not disturb other tenants

If the box also runs unrelated services (another VPN, an Outline/`shadowbox`
server, `watchtower`, a legacy `awg-quick@…` unit, etc.), those are **not** ours
and must never be stopped, recreated, pruned, or reconfigured. AWG 3.1 is rolled
out **additively** — never stop or recreate a live `amnezia-awg2` container that
carries existing peers.

Disk cleanup is limited to rotated logs (`journalctl --vacuum-size`) and
dangling/obsolete unused images. **Never** `docker system prune -a` or prune
volumes on a shared host.

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

### Shipping the node-agent image (build once, load on each host)

The node-agent image is **built once** (centrally or on a build host) and
**shipped** to each node; hosts only **load** the image, they never build it (the
compose file sets `pull_policy: never` and pins `NODE_AGENT_IMAGE` to an immutable
`sha256:` ID). Ship it with `docker save` piped into a remote `docker load`:

```sh
docker save "$NODE_AGENT_IMAGE" | ssh -i ~/.ssh/<NODE_KEY> root@<NODE_HOST> 'docker load'
```

Then set the same `NODE_AGENT_IMAGE=sha256:<id>` in that host's `infra/node/.env`.
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
does not exist until Docker is up.

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
| `apiBaseUrl` | `http://host.docker.internal:4001` (tunnel) or `https://<NODE_HOST>:<PORT>` (direct) |
| `apiKey` | *(from `secrets/`)* |
| `protocol` | `awg3` (primary; the node still serves awg2 peers) |
| `maxPeers` | node capacity (e.g. `250`) |

`supportedProtocols`, health, and capabilities are filled in automatically by
the worker's telemetry sync after the first successful poll. When `lastHealthAt`
starts advancing and `lastError` clears, the link is live.

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

See [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) for the node side (agent logs,
`/server` shape, backup/rollback).
