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

---

## 2. Reaching the node from the panel

The node-agent is bound to loopback on the server, so the control plane reaches
it in one of two ways:

**A. SSH tunnel (default, keeps the agent private).** The panel's worker runs in
Docker, so the tunnel must bind `0.0.0.0` (not just `127.0.0.1`) for
`host.docker.internal` to resolve it. Open it on the control-plane host and keep
it running (a terminal, `autossh`, or a service):

```bash
ssh -N -L 0.0.0.0:4001:127.0.0.1:4001 -i ~/.ssh/<NODE_KEY> root@<NODE_HOST>
```

- `0.0.0.0:4001` is reachable from the Docker network as `host.docker.internal:4001`.
- If the tunnel drops, the panel shows the node unhealthy with `lastError: "fetch failed"`.

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
