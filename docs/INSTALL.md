# Install guide — panel + Amnezia node

This is the single starting point for standing up Shared Panel end to end: one
control-plane **panel** and one or more VPN **nodes**, reachable over the public
internet behind a login you control.

**It's written for two readers at once — a person doing the install by hand, and
an AI agent doing it for you.** The steps are the same for both. Where a decision
is involved, a person just decides; an agent should ask the operator rather than
guess. Those spots are marked *"decide / ask."* Work top to bottom — this file is
the map, and it links to the detailed docs that carry the exact commands.

> **Two rules that always apply**
> - **Nothing secret goes into chat or git.** API tokens, keyrings, and node API
>   keys are entered by the operator or written to `secrets/` (git-ignored).
> - **Never disrupt a VPN that's already running.** On a server that already
>   hosts a node, look before you touch — do read-only recon and confirm before
>   any change ([`NODE-CONNECT.md` §1.1](./NODE-CONNECT.md)).

---

## 0. What to decide first

Settle these before touching anything — later steps refer back to them. *(A person
fills them in; an agent asks the operator and never invents an IP, domain, email,
or token.)*

| # | What you need | Where it's used |
| --- | --- | --- |
| 1 | **The server that will host the VPN node** — its **public IPv4 address** (use the address, not a DNS name: it is baked into every key and resolved by clients on their own network — [`NODE-CONNECT.md` §1.1](./NODE-CONNECT.md#use-the-ip-address-not-a-dns-name)) and SSH access. Note RAM/disk: 1 GB is fine for a node alone; add ~1 GB free if the panel shares the box. **Every server gets a 2 GB swapfile**, whatever its RAM: run `sudo bash scripts/ensure-swap.sh --apply` from the checked-out repo (idempotent, safe to re-run). That and the rest of the small-host settings are in [`SMALL-HOSTS.md`](./SMALL-HOSTS.md). | Phase 1 |
| 2 | **The public name users should see for that server** — e.g. `Germany`, `Server 1`. It is the first part of the connection title in the client (`<name> <key name>` by default, with the key number optional per key); separate from the internal admin name. | Node setup / Phase 6 |
| 3 | **Which machine runs the panel** — the same server as the node (co-located) or a separate host. Co-location is supported. | Phase 2 |
| 4 | **The domain the panel will live at** — e.g. `vpn.yourcompany.com`. Its DNS zone must be on Cloudflare. | Phase 3 |
| 5 | **Which emails are panel admins** — the first login by any of these becomes an admin. | Phase 2 / 5 |
| 6 | **Your Google Workspace domain + a Workspace super-admin** to approve the login integration. | Phase 3 |
| 7 | **A temporary Cloudflare API token** (broad, short-lived) — Phase 4 explains exactly what and where. It gets replaced by a least-privilege token and revoked. | Phases 3–4 |

If you don't own the domain or a Google Workspace yet, stop here — those are
prerequisites and can't be created for you.

**The pieces, in one breath:** a *node* is a VPN server (an AmneziaWG 3.1 container
plus a small agent the panel talks to); the *panel* is the web app + API +
database that manages users and drives the nodes; *Cloudflare* puts a login in
front of the panel on the public internet. You install them in that order.

---

## 1. Install the VPN node

**Goal:** a running node-agent (on `127.0.0.1:4001`, protected by an API key) in
front of an **AmneziaWG 3.1** container, on the server from input #1.

Follow **[`AGENT-HOST-SETUP.md` Part A](./AGENT-HOST-SETUP.md)** for the exact
commands. The shape of it:

1. Lay out `/opt/amnezia-panel-node`, generate the node API key (≥ 32 bytes), and
   build or pull the node-agent image (`infra/node`).
2. Fill in `infra/node/.env`: `SERVER_PUBLIC_HOST` is the public IPv4 address
   from input #1 (preflight prints a `NOTE:` if you give it a DNS name), and set
   `PROTOCOLS_ENABLED=amneziawg3` (3.1 only). Bring it up — the awg3 entrypoint
   randomises the obfuscation headers and writes `awg0.conf`.
3. Check `GET /server` reports `amneziawg3` and the container is healthy.

The public name from input #2 isn't set on the box — you'll enter it when you
register the node in Phase 6.

**Two things worth checking now**, because they fail silently:

- **Is it really 3.1?** Confirm the image is `amneziavpn/amneziawg-go:3.1.x` and
  that `awg0.conf` contains `HeaderProtectionKey` and `RandomTrailers = on` — a 2.0
  config can't carry those. If they're missing, the node quietly reports itself as
  protocol "2" even though the label says awg3.
- **Is the UDP port clear?** The node's public UDP port (default `51890`) must not
  sit inside a pre-existing `iptables` port-forward range. On a shared host a stale
  forward can hijack the port and every handshake fails with zero errors. Verify
  with `tcpdump -ni any udp port <PORT>` — packets should reach the awg container.

---

## 2. Install the panel

**Goal:** the panel stack (postgres + control-api + worker + web) running from the
published image, on the machine from input #3.

Follow **[`HOSTING.md` §3–§4](./HOSTING.md)** and use **`infra/prod`** (not the dev
stack):

1. Get the repo onto the panel host and `cp infra/prod/.env.example infra/prod/.env`.
2. Fill in `.env`: `POSTGRES_PASSWORD`, the `CONFIG_ENCRYPTION_KEYS_JSON` keyring
   (`openssl rand -base64 32`), `BOOTSTRAP_ADMIN_EMAILS` (input #5), and the
   `CF_ACCESS_*` values (you get those in Phase 3). Point `PANEL_IMAGE` at the GHCR
   image.
3. If the panel shares the box with the node (input #3), **put them on the same
   Docker network first** — they are two separate compose projects, so the panel
   cannot resolve `amnezia-node-agent` out of the box:

   ```bash
   cp infra/prod/compose.override.colocated.yaml.example infra/prod/compose.override.yaml
   ```

   That override attaches `control-api` and `worker` to the node's external
   network (`amnezia-node_default` by default; set `NODE_DOCKER_NETWORK` in
   `.env` if the node stack uses a different name — check with
   `docker network ls --filter name=amnezia-node`). Both `infra/prod/update.sh`
   and `scripts/deploy.sh` auto-load `compose.override.yaml`, so the wiring
   survives every redeploy. Then register the node with
   `apiBaseUrl http://amnezia-node-agent:4001`.

   Only use `http://host.docker.internal:4001` when the node-agent actually
   publishes on the host and that binding is reachable from the docker bridge.
   The stock node-agent binds `127.0.0.1` only ([`HOSTING.md` §7.1](./HOSTING.md)),
   so on a stock co-located host that address gets `ECONNREFUSED` — use the
   override, not the host route.

   Do **not** copy the override on a panel-only host: it declares the node
   network as `external`, and compose refuses to start if that network does not
   exist.
4. Bring it up: `bash infra/prod/update.sh` (it also runs the DB migrations).

The web and API are published on loopback only (`127.0.0.1:5430` / `5431`); what
actually exposes the panel to the world is the Cloudflare Tunnel in Phase 3.

**Turn on one-click updates** so the **Update** button in Administration → Overview
works: run `sudo bash infra/prod/install-updater.sh` once
([`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md)). After that, every future update is
one click and data-safe — backup, pull, migrate, restart, volumes untouched.

---

## 3. Public access: Cloudflare + Google Workspace login

**Goal:** `https://<panel domain>` (input #4) reaches the panel, gated by Cloudflare
Access, with Google Workspace as the login.

### 3.1 Tunnel + DNS

Create a Cloudflare **Tunnel** to the panel host and route the public hostname to
`http://localhost:5430`; Cloudflare creates the proxied DNS record for you. Install
`cloudflared` as a systemd service on the panel host. Details:
[`CLOUDFLARE-SETUP.md` §3](./CLOUDFLARE-SETUP.md).

### 3.2 Google Workspace as the login provider

Use the **Google Workspace** login method in Cloudflare Zero Trust so people sign
in with their company accounts, scoped to your Workspace domain (input #6) — not a
generic Google OAuth tied to some unrelated domain.

In **Zero Trust → Settings → Authentication → Login methods → Add → Google
Workspace**, you'll need:
- Your Workspace primary domain (input #6).
- An **App ID + Client secret** from a Google Cloud OAuth 2.0 **Web application**
  client in a project owned by your Workspace org. *(A Cloud project is still where
  OAuth clients are minted — that's just how Google works. The point is the client
  belongs to your Workspace and uses your domain.)* Set the authorized redirect URI
  to `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback`.
- Optionally, grant the connector the Admin SDK read scope so Workspace **groups**
  can be used as policy selectors later.

Then set **Accept all identity providers: OFF** on the app so only Google Workspace
is offered.

### 3.3 Access application + policy

Create a self-hosted Access application over `https://<panel domain>` — one public
hostname, no path, Google Workspace as the only IdP, instant-auth on, one-week
session. The allow policy (who may log in) is Phase 5. Click-by-click:
[`CLOUDFLARE-ACCESS.md` Part A](./CLOUDFLARE-ACCESS.md).

### 3.4 Wire the panel to Access

Read the app's **Audience (AUD)** tag and your team issuer, put them in
`infra/prod/.env` as `CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com` and
`CF_ACCESS_AUDIENCE=<AUD>`, and recreate control-api. With the VPN **off**, check
that `https://<panel domain>` sends you to the Google Workspace login and, after
signing in, into the panel.

> **Team domain is one per Cloudflare account.** `<TEAM>.cloudflareaccess.com` is
> shared by every Access app on the account, so the login page shows the
> account/team name — the app is isolated by its **AUD**, not by the login host.
> Reusing one Google Workspace IdP across apps is fine; never *edit* the shared IdP
> (that affects every app that uses it). More: [`ROLLOUT.md` §3](./ROLLOUT.md).

### 3.5 Optional — a direct login that doesn't need Cloudflare

Cloudflare isn't reachable for everyone (some networks in Russia, for example). So
the panel can **also** serve itself on a second, DNS-only host — one that bypasses
the Cloudflare proxy — with its **own** Google login. Both paths run side by side;
each person uses whichever works. Skip this whole section if everyone can reach
Cloudflare.

**First, decide how that direct host gets its TLS certificate** — this depends on
what already runs on the box, so there's no single answer. *(Decide / ask which of
these applies before doing anything.)*

- **A — the port 443 is free (simplest).** Install Caddy from
  [`infra/prod/Caddyfile.example`](../infra/prod/Caddyfile.example) (edit the host
  and email). It gets an automatic Let's Encrypt certificate and reverse-proxies
  `127.0.0.1:5430`. Use this when nothing else owns `:443`.
- **B — port 443 is already taken** by another service (a website, a VPN edge, an
  haproxy/nginx SNI router). Don't fight the existing terminator. Route the direct
  hostname through it to a **local Caddy on a loopback port** (e.g. one SNI rule:
  `req.ssl_sni -i direct.<panel domain>` → `127.0.0.1:<caddy port>`), and give Caddy
  a **static** certificate obtained separately — e.g. `acme.sh` over HTTP-01 on port
  80, or DNS-01 — instead of Caddy's automatic HTTPS (TLS-ALPN usually won't survive
  SNI passthrough). Point Caddy's `tls <cert> <key>` at the files, with a renew +
  reload hook. *(This is what the reference deployment does, because its `:443` is a
  VPN edge.)*
- **C — you terminate TLS yourself.** You already have a reverse proxy and cert for
  the direct host; just reverse-proxy it to `127.0.0.1:5430`. The panel needs
  nothing beyond a correct `PANEL_PUBLIC_URL`.

Whichever you pick, the end state is the same: the browser reaches
`https://direct.<panel domain>` with a valid certificate, and that edge forwards to
the panel web on `127.0.0.1:5430`.

**Then wire it up:**

1. **DNS.** Add an A record like `direct.<panel domain>` → the panel server's IP,
   **not** proxied by Cloudflare (grey cloud). Open the ports your method needs
   (A/B need 80 + 443). This name is for the panel only — on a co-located host
   do not reuse it as the node's `SERVER_PUBLIC_HOST` (input #1 is the address).
2. **TLS/edge.** Apply method A, B, or C.
3. **A Google OAuth client — from your Workspace, not a throwaway project.** In a
   Google Cloud project **owned by your Workspace org**, set the OAuth consent
   screen to **User type = Internal** (only your Workspace accounts can use it — no
   external app verification), then create a **Web application** client and add the
   redirect URI `https://direct.<panel domain>/api/auth/google/callback`. Copy the
   client ID and secret.
4. **Env** (`infra/prod/.env`, then recreate web + control-api):
   `PANEL_IDENTITY_SECRET` (`openssl rand -base64 32`), `GOOGLE_OAUTH_CLIENT_ID` /
   `GOOGLE_OAUTH_CLIENT_SECRET`, `PANEL_PUBLIC_URL=https://direct.<panel domain>`
   (must exactly match the redirect URI's host), and
   `AUTH_ALLOWED_DOMAINS=<your Workspace domain>`.
5. **Who may log in here.** On the direct path the **panel** decides: someone on an
   allowed email domain (`AUTH_ALLOWED_DOMAINS`) or a bootstrap admin logs in on
   their own; **anyone else must be added by an admin first** (Administration →
   Users). That's the "add a personal gmail" case — done in the panel, no Cloudflare
   dashboard. The Cloudflare path is unaffected.

Check it from a network **without** Cloudflare, VPN **off**: `https://direct.<panel
domain>` shows the panel's own **Sign in** button and, after signing in, lands in
the panel.

---

## 4. The Cloudflare API token: broad → least-privilege → revoke

The panel needs Cloudflare API access twice, at very different scopes. Handle it as
a hand-off — never leave a broad token lying around. *(An agent must not store the
broad token anywhere; the runtime token lives only encrypted inside the panel.)*

1. **A temporary broad token** — the operator mints it at **Cloudflare dashboard →
   My Profile → API Tokens → Create Token**. For a hands-off Phase 3 the practical
   scopes are: *Account · Cloudflare Tunnel: Edit*, *Zone · DNS: Edit* (the panel's
   zone), *Account · Access: Apps and Policies: Edit*, and *Account · Access:
   Organizations, Identity Providers and Groups: Edit*. It's used for this session
   only. *(Alternative: the operator does the Phase 3 dashboard clicks by hand and
   no broad token is ever issued — prefer this if they're available.)*
2. **Do the Phase 3 setup** with that token (or by hand).
3. **Mint the small runtime token.** The running panel only needs to edit the one
   Access policy, for the two-way user sync. Scope a token to *Account · Access:
   Apps and Policies: Edit* on **your account only**, nothing else. This is a Bearer
   API token, **not** an Access *service* token — don't mix them up
   ([`CLOUDFLARE-ACCESS.md` Part B](./CLOUDFLARE-ACCESS.md#the-api-token-this-needs)).
4. **Store the runtime token in the panel.** In **Administration → Policy →
   Cloudflare Access**, enter the account/app/policy IDs and paste the token; the
   panel encrypts it and never shows it again. *(CLI equivalent: `amnezia-panel
   cf-config --account= --app= --policy=` then `amnezia-panel cf-token <token>`.)*
   Then set `ACCESS_SYNC_ENABLED=true` in `infra/prod/.env` and recreate the worker.
5. **Revoke the temporary broad token** in the dashboard, and confirm only the
   least-privilege runtime token remains.

---

## 5. Admins vs. users

Two layers, kept separate on purpose:

- **Who may log in at all** is the Cloudflare Access allow policy (or, on the direct
  path, `AUTH_ALLOWED_DOMAINS` + pre-created users). The simplest model is one email
  allowlist, or — with Workspace groups wired in (§3.2) — a group like `vpn-users@`.
- **Who is an admin** is the panel role. The first sign-in by an email in
  `BOOTSTRAP_ADMIN_EMAILS` (input #5) becomes `admin`; everyone else is a regular
  `user`. You can promote/demote later in Administration → Users (the last admin can
  never be demoted, so no one locks everyone out).
- **An admin is also a user** — they have their own keys, quota, and the employee
  dashboard, exactly like anyone else. Admins are additionally *pinned*: the two-way
  sync never auto-disables them or drops them from the allowlist, so an admin can't
  accidentally lock themselves out.

You can express the split with a single allow policy (admin-ness is purely the panel
role — this is the default), or with two Include rules/groups (`admins@` and
`users@`) if you prefer that for org clarity; membership still only gates *login*,
the panel role still decides admin capability.

---

## 6. Wire it together and verify

1. **Register the node** in Administration → Nodes: internal name, the public name
   (input #2), `apiBaseUrl` (from Phase 2), and the node API key from Phase 1.
   Confirm it shows healthy and reports `awg3` ([`NODE-CONNECT.md` §3](./NODE-CONNECT.md)).
   *(Registering several nodes? Repeat this, or use the co-located CLI `node-add`
   — [`CLI.md`](./CLI.md).)* The global portal policy has an **allowed-node list**
   that limits which nodes **regular users** may pick; **admins always see every
   node**. Use it to keep a node admin-only or to stage it before general release.
2. **Make a test key** for yourself, import the **config file** into the Amnezia
   client (use a config file, not the QR, for split-tunnel profiles — a QR can't
   hold thousands of routes), and confirm the handshake completes and traffic
   flows. Import the **`.vpn` file**, not the `.conf`: both configure the same
   tunnel, but only the `.vpn` one keeps the connection name the panel composed.
   A `.conf` always arrives as "Server 1" — the client names it itself and
   nothing in the file changes that ([`CLI.md`](./CLI.md) has the detail).
3. **Check login** with the VPN off: `https://<panel domain>` → Google Workspace →
   panel.
4. **Check the two-way sync**: add or remove a user in the panel and confirm the
   Cloudflare policy updates; remove someone in Cloudflare and confirm they're
   disabled in the panel on the next cycle.

---

## Related documents

- [`ROLLOUT.md`](./ROLLOUT.md) — the whole rollout (Cloudflare + nodes + panel) on one page.
- [`CLI.md`](./CLI.md) — every command for the panel and a node.
- [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — node + control-plane install detail.
- [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) — Access app, allowlist, two-way sync, token scopes.
- [`CLOUDFLARE-SETUP.md`](./CLOUDFLARE-SETUP.md) — tunnel + Google login, click by click.
- [`HOSTING.md`](./HOSTING.md) — architecture, identity model, credential types, secrets.
- [`NODE-CONNECT.md`](./NODE-CONNECT.md) — registering and reaching a node.
- [`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md) — the in-panel Update button and its host worker.
