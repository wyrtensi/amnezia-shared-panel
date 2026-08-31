# Install runbook — panel + Amnezia node (agent-driven)

This is the **single entry point** for standing up Amnezia Panel end-to-end: one
control-plane **panel** and one or more VPN **nodes**, reached over the public
internet behind **Cloudflare Access + Google Workspace** login.

It is written for an **AI agent** performing the install. Work top to bottom:
first **collect the inputs in §0 by asking the operator**, then run the phases.
Each phase links to the detailed doc that carries the exact commands — this file
is the map and the decision points, not a copy of everything.

> Ground rules for the agent
> - **Ask, don't assume.** Every value in §0 comes from the operator. Never
>   invent an IP, a domain, an email, or a token.
> - **Secrets never go in chat or git.** API tokens, keyrings, and node API keys
>   are entered by the operator or written to `secrets/` (gitignored). See
>   [`HOSTING.md` §7](./HOSTING.md).
> - **Never disrupt a live VPN.** On a server that already runs a node, do
>   read-only recon first and confirm before any mutating step
>   ([`NODE-CONNECT.md` §1.1](./NODE-CONNECT.md)).

---

## 0. Inputs to collect (ask the operator first)

Ask these before touching anything. Record the answers; later phases reference
them by name.

| # | Question to ask | Used for |
| --- | --- | --- |
| 1 | **Which server hosts the VPN node?** (public IP/hostname + SSH access) | Phase 1. Note RAM/disk — a 1 GB box is fine for a node alone; co-locating the panel needs ~1 GB free. |
| 2 | **What public name should users see for this server?** e.g. `Германия`, `Server 1`. | Node `publicName`. It is shown in the client as `<public name> #<key number>`. Distinct from the internal admin name. |
| 3 | **Which machine runs the panel?** Same server as the node (co-located) or a separate host? | Phase 2. Co-location is supported (`infra/prod`); mem-limits protect the node. |
| 4 | **What domain will the panel live at?** A hostname under your **Google Workspace** domain, e.g. `vpn.yourcompany.com`. | Phase 3. Its DNS **zone must be on Cloudflare**. |
| 5 | **Which emails are panel admins?** (Google Workspace accounts) | `BOOTSTRAP_ADMIN_EMAILS`. First login by these becomes an admin (§5). |
| 6 | **Your Google Workspace domain + a Workspace super-admin** to consent to the login integration. | Phase 3 IdP. |
| 7 | **A temporary Cloudflare API token** (broad, short-lived) — see Phase 4 for exactly what and where. | Phases 3–4. The agent replaces it with a least-privilege token and has the operator revoke it. |

If the operator does not yet own the domain or a Workspace, stop and say so —
those are prerequisites you cannot create for them.

---

## 1. Phase 1 — Install the VPN node

Goal: a running **node-agent** (`127.0.0.1:4001`, x-api-key auth) fronting an
**AmneziaWG 3.1** container, on the server from input #1.

Follow **[`AGENT-HOST-SETUP.md` Part A](./AGENT-HOST-SETUP.md)**. In short:

1. Lay out `/opt/amnezia-panel-node`, generate the node API key secret (≥32
   bytes), build/pull the node-agent image (`infra/node`).
2. Fill `infra/node/.env`; set `PROTOCOLS_ENABLED=amneziawg3` (awg3 only — see the
   AWG note below). Bring it up; the awg3 entrypoint randomises the obfuscation
   headers and writes `awg0.conf`.
3. Verify `GET /server` reports `amneziawg3` and the container is healthy.

**Record the node's public name (input #2)** — you set it when you register the
node in Phase 6, not on the box.

**AWG 3.1 check (do this).** Confirm it is genuine 3.1, not 2.0-in-disguise: the
awg3 container image must be `amneziavpn/amneziawg-go:3.1.x`, and `awg0.conf` must
contain `HeaderProtectionKey` and `RandomTrailers = on` (a 2.0 config cannot).
If those markers are missing, the node-agent silently emits
`protocol_version: "2"` even though the label says awg3.

**Port hygiene (do this).** The node's public UDP port (default `51890`) must not
sit inside any pre-existing `iptables` port-forward range on the box. On a shared
host, a stale DNAP forward can hijack the port and every handshake fails silently
(0 completed handshakes). Verify with `tcpdump -ni any udp port <PORT>` — packets
must reach the awg container, not some other destination.

---

## 2. Phase 2 — Install the panel

Goal: the panel stack (postgres + control-api + worker + web) running from the
published image, on the machine from input #3.

Follow **[`HOSTING.md` §3–§4](./HOSTING.md)** and use **`infra/prod`** (not the
dev stack). In short:

1. On the panel host, get the repo and `cp infra/prod/.env.example infra/prod/.env`.
2. Fill `.env`: `POSTGRES_PASSWORD`, the `CONFIG_ENCRYPTION_KEYS_JSON` keyring
   (`openssl rand -base64 32`), `BOOTSTRAP_ADMIN_EMAILS` (input #5), and the
   `CF_ACCESS_*` values (filled in Phase 3). Set `PANEL_IMAGE` to the GHCR image.
3. If co-locating with the node (input #3), the app services already carry a
   `host.docker.internal` route; register the node with
   `apiBaseUrl http://amnezia-node-agent:4001` if they share a docker network, or
   `http://host.docker.internal:4001` for a host-published agent.
4. Bring it up: `bash infra/prod/update.sh` (it also runs DB migrations).

Publishing is loopback-only (`127.0.0.1:5430` web, `5431` control-api); the
Cloudflare Tunnel (Phase 3) is what exposes the web port.

**In-panel updates.** Install the host updater once so the Administration →
Overview **“Update”** button works: `sudo bash infra/prod/install-updater.sh`
([`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md)). Future updates are one click and
data-safe (backup → pull → migrate → restart; volumes untouched).

---

## 3. Phase 3 — Public access: Cloudflare Tunnel + Google Workspace login

Goal: `https://<panel domain>` (input #4) reaches the panel, gated by Cloudflare
Access, with **Google Workspace** as the only login method.

### 3.1 Tunnel + DNS

Create a Cloudflare **Tunnel** to the panel host and route the public hostname to
`http://localhost:5430`; Cloudflare auto-creates the proxied DNS record. Details:
[`CLOUDFLARE-SETUP.md` §3](./CLOUDFLARE-SETUP.md). Install `cloudflared` on the
panel host as a systemd service.

### 3.2 Google Workspace as the identity provider (not a throwaway Cloud OAuth)

Use the **Google Workspace** login method in Cloudflare Zero Trust so users sign
in with their **company Workspace accounts**, scoped to your Workspace domain
(input #6) — not a generic Google OAuth tied to some unrelated domain.

In **Zero Trust → Settings → Authentication → Login methods → Add → Google
Workspace**:

- **Google Workspace domain:** your Workspace primary domain (input #6).
- **App ID / Client secret:** from a Google Cloud OAuth 2.0 **Web application**
  client in a project owned by the Workspace org. (A Cloud project is still
  required to mint the OAuth client — that is inherent to Google IdP; the point is
  the client and login are bound to *your Workspace*, using your domain, not a
  separate/personal domain.) Authorized redirect URI:
  `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback`.
- Optional (for group-based policies in §5): grant the connector the Admin SDK
  read scope so Workspace **groups** are available as policy selectors.

Verify the login method, then set **Accept all identity providers: OFF** on the
app (§3.3) so only Google Workspace is offered.

### 3.3 Access application + policy

Create the self-hosted Access application over `https://<panel domain>` with one
public hostname and no path, Google Workspace as the sole IdP, instant-auth on,
1-week session. The **allow policy** is covered in §5 (admin/user split).

Full click-by-click: [`CLOUDFLARE-ACCESS.md` Part A](./CLOUDFLARE-ACCESS.md).

### 3.4 Wire the panel to Access

Read the app's **Audience (AUD)** tag and your team issuer, and set in
`infra/prod/.env`: `CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com` and
`CF_ACCESS_AUDIENCE=<AUD>`; recreate control-api. Verify with the VPN **off** that
`https://<panel domain>` redirects to the Google Workspace login and, after
sign-in, into the panel ([`HOSTING.md` §5.5](./HOSTING.md)).

### 3.5 Direct login without Cloudflare (server-side Google)

Cloudflare is not reachable for everyone (e.g. from some networks in Russia), so
the panel can **also** serve itself on a **DNS-only** host — bypassing the CF
proxy — with its **own** Google login, in addition to Cloudflare Access. Both
paths coexist; each user takes whichever works, and the API accepts either the CF
JWT or the panel's own signed session.

> **Optional phase — ask the operator first.** This whole subsection is opt-in. If
> everyone can reach Cloudflare, skip it. If you enable it, the **TLS/edge method
> below is not one-size-fits-all** — how the direct host terminates TLS depends on
> what already runs on the box. **Ask the operator which of A/B/C applies before
> touching anything**, and do not assume the reference (A).

**Step 0 — choose how the direct host gets TLS (ask the operator):**

- **A. Dedicated host / port 443 free → reference method.** Install Caddy from
  [`infra/prod/Caddyfile.example`](../infra/prod/Caddyfile.example) (edit host +
  email); it gets an automatic Let's Encrypt cert and reverse-proxies
  `127.0.0.1:5430`. Simplest — use it when nothing else owns `:443`.
- **B. Port 443 already used by another service** (an existing site, a VPN edge, an
  `haproxy`/`nginx` SNI router). **Do not fight the existing terminator.** Route
  the direct hostname through it to a **local Caddy on a loopback port** (e.g. add
  one SNI rule: `req.ssl_sni -i direct.<panel domain>` → `127.0.0.1:<caddy port>`),
  and give Caddy a **static** cert obtained out-of-band — e.g. `acme.sh` HTTP-01 on
  port 80, or DNS-01 — rather than Caddy's ALPN/auto-HTTPS (TLS-ALPN usually will
  **not** survive SNI passthrough). Point Caddy's `tls <cert> <key>` at the
  installed files with an auto-renew reload hook. *(This is what the reference
  deployment actually does, because its `:443` is a VPN edge.)*
- **C. Operator terminates TLS themselves.** They already have a reverse proxy /
  cert for the direct host and just reverse-proxy it to `127.0.0.1:5430`. The panel
  needs nothing beyond a correct `PANEL_PUBLIC_URL`.

Whichever you pick: the browser must reach `https://direct.<panel domain>` with a
**valid** cert, and that edge must forward to the panel web on `127.0.0.1:5430`.

**Then:**

1. **DNS-only host.** Add an A record, e.g. `direct.<panel domain>` → the panel
   server's IP, **not** proxied by Cloudflare (grey cloud). Open the ports the
   chosen method needs (A/B: 80 + 443).
2. **TLS/edge.** Apply method A, B, or C from Step 0.
3. **Google OAuth client — from your Business Workspace, not a throwaway Cloud
   project.** In a Google Cloud project **owned by your Workspace organization**,
   set the OAuth consent screen **User type = Internal** (so only your Workspace
   accounts can use it — no external app verification), then create a **Web
   application** OAuth client and add the redirect URI
   `https://direct.<panel domain>/api/auth/google/callback`. Copy the client ID +
   secret. *(A Cloud project is still where OAuth clients are minted — that is
   inherent to Google. The point is it belongs to your Workspace and is Internal,
   the same client family as the Cloudflare IdP in §3.2, not a personal project on
   an unrelated domain.)*
4. **Env** (`infra/prod/.env`, then recreate web + control-api):
   `PANEL_IDENTITY_SECRET` (shared secret, `openssl rand -base64 32`),
   `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`,
   `PANEL_PUBLIC_URL=https://direct.<panel domain>` (must exactly match the host in
   the redirect URI), and `AUTH_ALLOWED_DOMAINS=<your Workspace domain>`.
5. **Allowlist (direct path).** The **panel** decides who may log in directly: an
   allowed email domain (`AUTH_ALLOWED_DOMAINS`) or a bootstrap admin
   self-provisions; **anyone else must be pre-created by an admin** in
   Administration → Users. That is the "add a personal gmail" flow — done in the
   panel, no Cloudflare dashboard. (The Cloudflare path is unchanged — CF gates it
   at the edge.)

Verify from a network **without** Cloudflare and with the **VPN off**:
`https://direct.<panel domain>` shows the panel's own **Sign in** button, and
after sign-in lands in the panel.

---

## 4. Phase 4 — Cloudflare API token: temporary broad → least-privilege → revoke

The agent needs Cloudflare API access **twice**, with very different scopes.
Handle it as a hand-off, never leaving a broad token in place.

1. **Temporary broad token (operator creates, short-lived).** Ask the operator to
   mint one at **Cloudflare dashboard → My Profile → API Tokens → Create Token**.
   For a fully hands-off Phase 3, the practical scopes are: **Account · Cloudflare
   Tunnel: Edit**, **Zone · DNS: Edit** (the panel's zone), **Account · Access:
   Apps and Policies: Edit**, and **Account · Access: Organizations, Identity
   Providers and Groups: Edit**. The operator pastes it to the agent for this
   session only. *(Alternative: the operator does the dashboard clicks in Phase 3
   and no broad token is ever issued — prefer this if they are available.)*

2. **Do the setup** (tunnel, DNS record, Access app + policy, IdP) with that token
   or the dashboard.

3. **Mint the least-privilege runtime token.** The *running* panel only needs to
   edit the one Access policy for the two-way user sync. Create a token scoped to:
   **Account · Access: Apps and Policies: Edit** (Edit implies Read), **Account
   Resources → Include → your specific account only**. Nothing else. This is a
   **Bearer API token**, not an Access *service* token — do not confuse them
   ([`CLOUDFLARE-ACCESS.md` Part B](./CLOUDFLARE-ACCESS.md#the-api-token-this-needs)).

4. **Store the runtime token in the panel (encrypted, write-only).** In
   **Administration → Policy → Cloudflare Access**, enter the account/app/policy
   IDs and paste the runtime token; the panel encrypts it at rest and never shows
   it again. (CLI equivalent: `amnezia-panel cf-config --account= --app= --policy=`
   then `amnezia-panel cf-token <token>`.) Then set `ACCESS_SYNC_ENABLED=true` in
   `infra/prod/.env` and recreate the worker.

5. **Revoke the temporary broad token** in the Cloudflare dashboard. Confirm to
   the operator that only the least-privilege runtime token remains.

The agent must **not** store the broad token anywhere; the runtime token lives
only encrypted inside the panel DB.

---

## 5. Phase 5 — Admin / user policy split

Roles live in the **panel**, and Cloudflare Access is the login gate — keep the
two layers straight:

- **Who may log in at all** = the Cloudflare Access **allow policy** `include`
  list. The recommended model is either an explicit **email allowlist** or, with
  Workspace groups wired in (§3.2), a **Workspace group** (e.g. `vpn-users@`).
- **Who is an admin** = the panel `role`. First sign-in by an email in
  `BOOTSTRAP_ADMIN_EMAILS` (input #5) is provisioned as `admin`; everyone else is a
  regular `user`. Admins can also be promoted/demoted later in Administration →
  Users (the last admin can never be demoted).
- **An admin is also a user.** Admins have their own VPN keys, quota, and the
  employee dashboard, exactly like a user — this is expected and supported. Admins
  are additionally **pinned** in the two-way sync: they are never auto-disabled and
  never dropped from the Access allowlist, so an admin can’t lock themselves out.

Two ways to express the split in Cloudflare, both fine:

1. **Single allow policy (simplest).** One email/group allowlist grants login;
   admin-ness is purely the panel role. The two-way sync keeps the allowlist equal
   to the panel's active users. This is the default the panel drives.
2. **Two Include rules / groups (optional, for org clarity).** An `admins@` group
   and a `users@` group both Included in the one allow policy. Membership still
   only gates *login*; the panel role still decides admin capability. If you use
   this, keep `BOOTSTRAP_ADMIN_EMAILS` in sync with the `admins@` group.

Nothing in the panel breaks with an admin-who-is-a-user: key limits, quota
requests (a user can raise their own via Administration; the request UI shows the
requester's *current → requested* limit), and the sync all treat the account as a
normal user plus the admin role.

---

## 6. Phase 6 — Wire together and verify

1. **Register the node** in Administration → Nodes: internal name, **public name
   (input #2)**, `apiBaseUrl` (Phase 2 step 3), and the node API key from Phase 1.
   Confirm it shows healthy and reports `awg3`.
   ([`NODE-CONNECT.md` §3](./NODE-CONNECT.md)).
2. **Create a test key** for yourself, import the **config file** into the Amnezia
   client (for split-tunnel profiles use the config file, not the QR — QR can't
   hold thousands of routes), and confirm the handshake completes and traffic
   flows.
3. **Verify login** with the VPN off: `https://<panel domain>` → Google Workspace
   → panel.
4. **Verify the two-way sync**: add/remove a user in the panel and confirm the
   Cloudflare policy `include` list updates; remove someone in Cloudflare and
   confirm they are disabled in the panel on the next cycle.

## Related documents

- [`AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — node + control-plane install detail.
- [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) — Access app, allowlist, two-way sync, token scopes.
- [`CLOUDFLARE-SETUP.md`](./CLOUDFLARE-SETUP.md) — tunnel + Google login click-by-click.
- [`HOSTING.md`](./HOSTING.md) — architecture, identity model, credential types, secrets.
- [`NODE-CONNECT.md`](./NODE-CONNECT.md) — registering and reaching a node.
- [`UPDATE-MECHANISM.md`](./UPDATE-MECHANISM.md) — the in-panel update button + host worker.
