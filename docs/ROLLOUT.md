# Rollout: Cloudflare + nodes + panel, end to end

How the whole system is deployed in practice, in one place: the **panel** control
plane, the **VPN nodes**, and the **Cloudflare** edge that puts a login in front of
the panel. This is the map; each step links to the doc that carries the exact
commands. Everything here is generic — fill your own domain, account, and IDs into
the placeholders (`<PANEL_DOMAIN>`, `example.com`, `<node-domain>`, node names like
`germany` / `finland`, `<ACCOUNT_ID>`, `<AUD>`, `<POLICY_ID>`, `<CF_API_TOKEN>`,
`<NODE_KEY>`, `<TEAM>`). The repo hardcodes none of them.

Deploy in this order: **node(s) → panel → Cloudflare edge → two-way sync**.

---

## 1. Topology at a glance

```
        the public              Cloudflare edge            Panel host (infra/prod)         VPN node(s) (infra/node)
   ┌──────────────────┐      ┌────────────────────┐     ┌────────────────────────┐      ┌──────────────────────┐
   │ browser, VPN off │ TLS  │ Cloudflare proxy    │     │ web        127.0.0.1:5430│      │ amnezia-node-agent   │
   │ <PANEL_DOMAIN>   │─────▶│  + Access (Google)  │────▶│ control-api 127.0.0.1:5431│     │  127.0.0.1:4001       │
   └──────────────────┘      │  injects JWT header │ CF  │ worker ─────────────────┼─────▶│  amnezia-awg3 UDP …   │
                             └────────────────────┘Tunnel│ postgres (not published)│ priv │  amnezia-awg2 UDP …   │
                          outbound-only, origin IP hidden └────────────────────────┘      └──────────────────────┘
```

- **Panel** — `infra/prod` (postgres + control-api + worker + web), published on
  **loopback only** (`127.0.0.1:5430` / `5431`). Nothing listens on a public port.
- **Public access** — a **Cloudflare Tunnel** (`cloudflared`, outbound-only) routes
  `<PANEL_DOMAIN>` → `http://localhost:5430`. No inbound `:443`, origin IP hidden.
- **Login** — **Cloudflare Access** (Google Workspace IdP + email allowlist) in
  front of the tunnel. The panel implements no login of its own; it verifies the
  Access JWT.
- **Nodes** — one `infra/node` deployment per server: `amnezia-awg2` +
  `amnezia-awg3` + a loopback-only `amnezia-node-agent` (`127.0.0.1:4001`).
  **AmneziaWG 3.1 is the primary protocol**; 2.0 is compatibility-only.
- **Panel ↔ node** — only the worker talks to a node, over the node network (when
  co-located) or an approved private transport (when on separate hosts).

---

## 2. Panel host

Run the **`infra/prod`** stack (not `infra/dev`). Full steps:
[`CLOUDFLARE-SETUP.md` §2](./CLOUDFLARE-SETUP.md).

- `cp infra/prod/.env.example infra/prod/.env`, then set `PANEL_IMAGE` (the GHCR
  image), `POSTGRES_PASSWORD`, the `CONFIG_ENCRYPTION_KEYS_JSON` keyring
  (`openssl rand -base64 32`), `BOOTSTRAP_ADMIN_EMAILS`, and the two `CF_ACCESS_*`
  values (from §3).
- Bring it up with `bash infra/prod/update.sh` (backup → pull → migrate → up; it
  also runs migrations). Web binds `127.0.0.1:5430`, control-api `127.0.0.1:5431`,
  postgres is never published. Ports are overridable via `WEB_PUBLISH_PORT` /
  `CONTROL_API_PUBLISH_PORT`.
- **On a small box:** add a **2 GB swapfile** (the image pull/build and the Node
  services are memory-hungry) and install the **Docker Compose v2 plugin** if it is
  missing. `compose.yaml` already caps each service's memory so a co-located node's
  VPN containers can never be OOM-killed by the panel. Full guidance —
  swap, task budgets, Postgres sizing, and why you must not build images
  there — is in [`SMALL-HOSTS.md`](./SMALL-HOSTS.md).
- Turn on one-click updates once: `sudo bash infra/prod/install-updater.sh`
  ([`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md)).

---

## 3. Public edge: Cloudflare Tunnel + Access + Google Workspace

Detail: [`CLOUDFLARE-SETUP.md`](./CLOUDFLARE-SETUP.md) (tunnel + app) and
[`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) (app + policy).

**Tunnel.** Install `cloudflared` as a **host systemd service** on the panel host
and route `<PANEL_DOMAIN>` → `http://localhost:5430`. It dials **outbound-only**
(QUIC/HTTPS 443) to Cloudflare: **no inbound port is opened**, the **origin IP
stays hidden**, and Cloudflare writes the proxied (orange-cloud) DNS record for
you. The orange cloud is required so the panel is reachable **with the VPN off**.

**Access.** Put a **self-hosted Access application** over `<PANEL_DOMAIN>` with a
**Google Workspace** identity provider and a single **Allow** policy (an email
allow-list). Wire the two public values into `infra/prod/.env`:

```
CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com
CF_ACCESS_AUDIENCE=<AUD>
```

control-api fetches Cloudflare's JWKS and verifies the `Cf-Access-Jwt-Assertion`
on every request; the first login by a `BOOTSTRAP_ADMIN_EMAILS` address becomes
admin. The login/JWT path needs **no API token** — just those two public values.

### The team-domain nuance (important)

The Cloudflare **team domain** (`<TEAM>.cloudflareaccess.com`) is **one per
Cloudflare account** and is shared by **every** Access application on that account.
The login page therefore reflects the **account/team** name, not the individual
app — two panels on the same account share the same `CF_ACCESS_ISSUER` and differ
only by `CF_ACCESS_AUDIENCE`. Each application is still **fully isolated** by its
own **AUD** and its own policy.

Likewise, **reusing one Google Workspace IdP across several apps is safe** — you
only *reference* it. **Never edit the shared IdP** to suit one app: editing it
affects every application that uses it.

---

## 4. Two-way Access sync

The worker keeps the panel's active users and the Access policy's allow-list in
sync **both ways**:

- **Add/remove in the panel → updates the Cloudflare policy** `include` list, so a
  new user can actually reach the login and a removed user cannot.
- **Remove someone in Cloudflare → disables them in the panel** and revokes their
  VPN keys (removal from Access alone stops sign-in but not existing keys).

Configure it in **Administration → Policy → Cloudflare Access** with the
account/app/policy IDs plus an **API token scoped to `Access: Apps and Policies:
Edit`** (account-scoped, nothing else) — or headlessly via the CLI:

```sh
amnezia-panel cf-config --account=<ACCOUNT_ID> --app=<APP_ID> --policy=<POLICY_ID>
amnezia-panel cf-token <CF_API_TOKEN>     # stored encrypted at rest, write-only
```

Then enable it (`ACCESS_SYNC_ENABLED=true`) and recreate the worker. **Bootstrap
admins (`BOOTSTRAP_ADMIN_EMAILS`) are pinned** — the sync never drops them from the
policy or disables them, so the allow-list can never empty itself and lock everyone
out. Full behavior, safety rails, and the exact Cloudflare API calls:
[`CLOUDFLARE-ACCESS.md` Part B](./CLOUDFLARE-ACCESS.md).

> The management **API token** (Bearer, to `api.cloudflare.com`) is **not** an
> Access **service token** (two custom headers that only get a machine *past* the
> gate). See [`HOSTING.md` §6](./HOSTING.md).

---

## 5. Co-location networking

The panel and a node **can** share one host. How the panel's `control-api` +
`worker` reach the node-agent depends on where the node lives:

- **Same host (co-located) — attach to the node's Docker network.** Add a Compose
  override that joins `control-api` + `worker` to the node's network, so they reach
  the agent by container name:

  ```yaml
  # infra/prod/compose.override.yaml
  services:
    control-api:
      networks: [panel, amnezia-node_default]
    worker:
      networks: [panel, amnezia-node_default]
  networks:
    amnezia-node_default:
      external: true
  ```

  Register the node with **`apiBaseUrl: http://amnezia-node-agent:4001`**.
  (Alternatively use the panel's built-in `host.docker.internal` route and register
  with `http://host.docker.internal:4001`.)

- **Separate hosts — use an approved private transport.** The node-agent is
  loopback-only by default (`127.0.0.1:4001`, never public). Reach it over an SSH
  tunnel and register with `http://host.docker.internal:4001` — see
  [`NODE-CONNECT.md` §2](./NODE-CONNECT.md).

Whichever applies, TCP 4001 is **never** opened on a non-loopback address of the
node.

---

## 6. VPN nodes

One `infra/node` deployment per server: `amnezia-awg2` (a UDP port) +
`amnezia-awg3` (a UDP port) + `amnezia-node-agent` (`127.0.0.1:4001`).
**AmneziaWG 3.1 is the primary protocol** for new nodes and new keys; 2.0 is kept
only for peers already issued on existing nodes. Full runbook:
[`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md).

**Additive alongside an existing, unrelated Amnezia install.** A node can go onto a
host that already runs a separate Amnezia (or other VPN) install **without
disrupting it**, because this stack uses its **own** container names (`amnezia-awg2`
/ `amnezia-awg3` / `amnezia-node-agent`), its **own** UDP ports, its **own** Docker
network, and its **own** Compose project (`amnezia-node`). Always do **read-only
recon first** (`docker ps`, `ss -lun`) and pick ports that do not clash — never
re-port or restart the other tenant's containers.
See [`NODE-CONNECT.md` §1](./NODE-CONNECT.md).

**Ship the image; hosts never build.** The node-agent image is **built once**
(centrally or on a build host) and **shipped** to each node with
`docker save | ssh 'docker load'`; the compose file pins `NODE_AGENT_IMAGE` to an
immutable `sha256:` ID with `pull_policy: never`, so a node only **loads** images:

```sh
docker save "$NODE_AGENT_IMAGE" | ssh -i ~/.ssh/<NODE_KEY> root@<node-domain> 'docker load'
```

Several nodes (e.g. `germany`, `finland`) are stood up the same way.

---

## 7. Registering nodes with the co-located admin CLI

On the panel host, the `amnezia-panel` CLI mints an `x-panel-identity` token from
**`PANEL_IDENTITY_SECRET`**, so an operator **on the panel host is admin in
production without a browser login**. Run it inside the control-api container,
which already carries the secret — see [`CLI.md`](./CLI.md):

```sh
CID=$(docker compose -f infra/prod/compose.yaml ps -q control-api)
# register the co-located node
docker exec -i "$CID" node apps/cli/dist/main.js \
  node-add --name=germany --api-url=http://amnezia-node-agent:4001 --api-key-file=- \
  < infra/node/secrets/node-agent-api-key
# and the Cloudflare two-way sync config, headless
docker exec "$CID" node apps/cli/dist/main.js cf-config --account=<ACCOUNT_ID> --app=<APP_ID> --policy=<POLICY_ID>
docker exec "$CID" node apps/cli/dist/main.js cf-token <CF_API_TOKEN>
```

Register each additional node the same way (`node-add` per server). The node's
`supportedProtocols`, health, and capabilities fill in automatically after the
first telemetry poll.

---

## 8. Per-user node availability

The global **portal policy** has an **allowed-node list** (`allowedNodeIds`) that
restricts which nodes may be selected in the key wizard. It applies to **every**
account, admins included (it is not bypassed by role). To let specific people —
e.g. admins — reach nodes outside the global list, give them a **per-user
override**:

```sh
# global: everyone is limited to these node(s)
amnezia-panel policy-set --allowedNodeIds=<node-id>[,<node-id>…]
# per-user: this account sees every node, overriding the global list
amnezia-panel user-nodes <admin@example.com> all
```

`user-nodes … all` clears the restriction for that account (`… none` blocks all; a
comma list scopes it to specific nodes). Note the **admin Nodes page always lists
every node**; this list only governs the **key-wizard** node choice. Use it to keep
some nodes admin-only or to stage a node before opening it to everyone.

**Server order and recommended servers.** Separately from availability, the
global policy carries two lists. *Server order* is the order users see: the
servers you arrange come first, in your order; the ones you have not arranged
follow, sorted by name. *Recommended* servers get a "Recommended" badge on the
dashboard and in the key wizard.

The badge is only a badge: it never moves a server. To keep the badge where the
eye expects it, only servers at the **top** of the order may be recommended —
the recommended list has to be the first N entries of the server order, and a
server you have not placed in the order cannot be recommended at all. The admin
UI enforces this by letting you tick servers from the top down; the API rejects
anything else with an error naming the server that is out of place. If you
reorder the list and the current recommendations would end up in the middle,
send both lists in one command.

Neither list changes who may use what. A recommended server that a user is not
allowed to use is not shown to that user at all, is never chosen for them when
server selection is off, and nothing is substituted for it — availability
(`allowedNodeIds`, globally or per user) is always decided first.

```sh
amnezia-panel nodes                                     # the order users see, with ids
amnezia-panel policy                                    # both lists + an order check
amnezia-panel policy-set --nodeOrder=<node-id>,<node-id>,<node-id>
amnezia-panel policy-set --recommendedNodeIds=<node-id>   # must be first in the order
amnezia-panel policy-set --nodeOrder=<node-b>,<node-a> --recommendedNodeIds=<node-b>
amnezia-panel policy-set --recommendedNodeIds=none        # clear the badges
```

Deleting a node removes it from both lists automatically.

---

## 9. Verify end to end

1. **Node healthy** — Administration → Nodes: green, recent sync, both protocols
   ([`NODE-CONNECT.md` §4](./NODE-CONNECT.md)).
2. **Login off-VPN** — with the VPN **off**, `https://<PANEL_DOMAIN>` reaches the
   Google login and, for an allow-listed account, the panel; a non-listed account
   is blocked at the edge.
3. **Admin** — a `BOOTSTRAP_ADMIN_EMAILS` address sees the admin nav.
4. **Key** — create a key (defaults to AWG 3.1), import the config into the Amnezia
   client, confirm the handshake and traffic.
5. **Two-way sync** — add/remove a user in the panel and confirm the Cloudflare
   policy updates; remove someone in Cloudflare and confirm they are disabled in
   the panel on the next cycle.

---

## Related documents

- [`INSTALL.md`](./INSTALL.md) — the numbered install runbook (person + agent).
- [`CLOUDFLARE-SETUP.md`](./CLOUDFLARE-SETUP.md) — tunnel + Access app, click/API.
- [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) — Access app, allow-list, two-way sync.
- [`HOSTING.md`](./HOSTING.md) — architecture, identity model, credential types.
- [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — node + control-plane install detail.
- [`NODE-CONNECT.md`](./NODE-CONNECT.md) — connecting and reaching a node.
- [`CLI.md`](./CLI.md) — every panel and node command.
- [`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md) — the in-panel Update button.
</content>
