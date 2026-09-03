# Hosting the whole thing: node + panel + public access

This is the top-level, end-to-end guide for raising Amnezia Panel in production:
the **AWG host** (VPN node), the **control-plane panel**, and the **public
hosting** in front of it via **Cloudflare + Cloudflare Access** (Google IdP with
an email allowlist) behind the **Cloudflare proxy**.

It deliberately does **not** repeat the detailed runbooks — it ties them
together and adds the piece none of them cover on its own (public exposure and
identity). Follow the linked docs for each half:

- [`docs/AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — install a fresh AWG host
  and wire it to the panel (generic, any host).
- [`docs/NODE-CONNECT.md`](./NODE-CONNECT.md) — the concrete runbook for the live
  production node (the live node), including the SSH tunnel and safety rules.
- [`docs/CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) — auto-deactivating panel
  accounts when they are removed from Access (worker reconcile).

> The straightforward-path rule from `AGENTS.md` applies here too: if a step
> cannot be completed as written, stop and report the blocker rather than
> improvising a detour. Do not invent Cloudflare fields or endpoints.

---

## 1. Architecture recap

The system is two independently deployed halves plus a public edge.

**Control plane** (one central deployment — `infra/dev` compose stack):

| Component | Role | Dev bind |
| --- | --- | --- |
| `apps/web` | Employee + admin UI. Server-side proxy to the control API; the only public-facing component. | `127.0.0.1:3000` |
| `apps/control-api` | Authenticated central REST API. Every capability is API-first. | `127.0.0.1:3001` |
| `apps/worker` | Provisioning, telemetry, retention, routing feeds, access-reconcile. The only component that talks to a node. | (no public port) |
| `postgres` | State store (`packages/db`). | not published |

**VPN node** (one deployment per server — `infra/node` compose stack): the
`amnezia-awg3` (UDP 51890) and `amnezia-awg2` (UDP 51889) containers plus a
loopback-only `amnezia-node-agent` on `127.0.0.1:4001`. The worker reaches it
over an SSH tunnel, never over the public internet. Full details in
[`AGENT-HOST-SETUP.md` §1](./AGENT-HOST-SETUP.md).

**Protocol:** the project targets **AmneziaWG 3.1** as its primary protocol
(header protection, ranged headers, random trailers; requires the official
AmneziaVPN client 5.0.1.5+). **AWG 2.0 (`awg2`) is compatibility-only** — kept
for peers already issued on existing nodes (including the operator's own
connection), never the target for new features. New nodes and new keys default
to AWG 3.1.

```
        the public                Cloudflare edge              Control-plane host            VPN node (Linux/amd64)
   ┌──────────────────┐        ┌───────────────────┐        ┌────────────────────────┐    ┌──────────────────────┐
   │ browser, VPN off  │  TLS  │ Cloudflare proxy   │  TLS  │ apps/web (:3000)        │    │ amnezia-node-agent    │
   │ panel.<domain>    │──────▶│  + Access (Google) │──────▶│  └▶ control-api (:3001) │    │  127.0.0.1:4001       │
   └──────────────────┘        │  injects JWT header│       │     worker ────────────┼SSH▶│  awg3 UDP 51890       │
                              └───────────────────┘        │     postgres            │    │  awg2 UDP 51889       │
                                                            └────────────────────────┘    └──────────────────────┘
```

Only `apps/web` is ever exposed publicly, and only through Cloudflare. The
control-api, worker, and postgres stay on the loopback / internal network.

---

## 2. How authentication works

**The panel implements no login of its own.** It trusts identity asserted by
Cloudflare Access:

1. Access authenticates the user (Google), then injects a signed
   **`Cf-Access-Jwt-Assertion`** header on every request to the origin.
2. `apps/web` forwards that header verbatim to the control-api
   (`apps/web/app/api/control/[...path]/route.ts` and `apps/web/lib/server-api.ts`).
3. `apps/control-api` **cryptographically verifies** the JWT in
   `apps/control-api/src/cloudflareAccess.ts` — it fetches Cloudflare's JWKS from
   `<issuer>/cdn-cgi/access/certs`, checks `issuer`, `audience`, and `RS256`,
   then reads the `email` claim (lower-cased) as the user identity. The verify
   happens in the API, so the API does not blindly trust the proxy — defense in
   depth.
4. On first request the control repository auto-provisions that email as a user.
   If the email is in **`BOOTSTRAP_ADMIN_EMAILS`** (control-api env, comma-
   separated, lower-cased), the account is promoted to `admin`. This is how the
   first admin(s) exist — there is no seed script.

The two env vars the production adapter requires (`apps/control-api/main.ts`
creates it only when `NODE_ENV=production`):

| Var | Value | Where to find it |
| --- | --- | --- |
| `CF_ACCESS_ISSUER` | `https://<your-team>.cloudflareaccess.com` | Zero Trust → Settings → Custom Pages / your team domain. |
| `CF_ACCESS_AUDIENCE` | the Access application **Application Audience (AUD) tag** | The Access application's Overview / Settings page. |

**In development** there is no Access. The control-api instead trusts an
**`x-dev-user-email`** header (`getDevelopmentIdentity` in
`apps/control-api/src/app.ts`), which the web proxy injects from `DEV_USER_EMAIL`
when `DEV_IDENTITY_ENABLED=true`. This dev adapter is selected only when
`NODE_ENV=development` and is unavailable in production. See
[`AGENT-HOST-SETUP.md` §C.3](./AGENT-HOST-SETUP.md) for the dev identity flow.

---

## 3. Raise order (end-to-end)

Do these in order; each links to the doc that owns the detail.

1. **Stand up the VPN node.** Follow [`AGENT-HOST-SETUP.md` Part A](./AGENT-HOST-SETUP.md)
   for a fresh host, or [`NODE-CONNECT.md`](./NODE-CONNECT.md) for the live
   the live node box. Ask the operator for the node's **display name** first
   (`AGENTS.md` rule).
2. **Open the private transport** (SSH tunnel) and **register the node** in the
   panel — [`AGENT-HOST-SETUP.md` Part B](./AGENT-HOST-SETUP.md) /
   [`NODE-CONNECT.md` §2–3](./NODE-CONNECT.md).
3. **Run the control plane.** In production use the **`infra/prod`** stack (loopback
   ports `5430`/`5431`, pulls the published image) with the identity wiring in §5.4
   below — see [`ROLLOUT.md`](./ROLLOUT.md) and
   [`CLOUDFLARE-SETUP.md` §2](./CLOUDFLARE-SETUP.md). For a local/dev stack, see
   [`AGENT-HOST-SETUP.md` Part C](./AGENT-HOST-SETUP.md).
4. **Put the panel behind Cloudflare + Access** — §4 and §5 of this guide.
5. **Verify the panel opens with the VPN OFF** — §5.5. This is a hard
   requirement, not a nicety.
6. *(Optional)* **Turn on access-reconcile** so removing someone from Access also
   disables their panel account and revokes keys —
   [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md).

---

## 4. Public hosting: put the panel behind the Cloudflare proxy

The panel domain **must be proxied by Cloudflare (orange cloud)** so that it is
reachable **without a working VPN**. This is a hard requirement: people open the
panel precisely when their VPN is broken. A grey-cloud (DNS-only) record, or a
panel reachable only through the VPN, defeats the purpose.

Pick a hostname you will use for the panel — e.g. `panel.<your-domain>`. You
will fill your real domain in throughout; the repo does not hardcode one.

Two supported ways to expose the `apps/web` origin (:3000) to Cloudflare — choose
one:

- **Proxied DNS record (orange cloud).** Create an `A`/`AAAA` record for
  `panel.<your-domain>` pointing at the control-plane host's public IP, with the
  Cloudflare proxy **enabled (orange cloud)**. Lock the origin firewall so it
  only accepts 443 from Cloudflare's IP ranges (or use an origin cert /
  Authenticated Origin Pulls).
- **Cloudflare Tunnel (`cloudflared`).** Run a tunnel from the control-plane host
  to Cloudflare and route `panel.<your-domain>` to the panel web port
  (`http://localhost:5430` for the `infra/prod` stack). The origin then needs no
  inbound ports at all. This is the recommended path — see
  [`ROLLOUT.md`](./ROLLOUT.md) and [`CLOUDFLARE-SETUP.md`](./CLOUDFLARE-SETUP.md).

Either way the public hostname terminates at Cloudflare first, which is what lets
Access sit in front of it and what keeps the panel reachable off-VPN.

---

## 5. Cloudflare Access: Google IdP + email allowlist

Access is configured in the Cloudflare **Zero Trust** dashboard (or via the REST
API — see §6). The steps below are the model; fill in your own domain, account,
and IDs.

### 5.1 Configure the Google identity provider

Zero Trust → **Settings → Authentication → Login methods → Add new → Google**.
Create an OAuth client in the Google Cloud Console (Client ID + Client Secret)
and paste it in. This makes "Google" an available IdP for Access policies.

### 5.2 Create the Access application

Zero Trust → **Access → Applications → Add an application → Self-hosted**:

- **Application name:** e.g. `Amnezia Panel`.
- **Application domain:** `panel.<your-domain>` — the proxied hostname from §4.
  *(This is the domain you fill in later once DNS is live.)*
- **Identity providers:** enable **Google** (from §5.1). Optionally disable the
  others so Google is the only path.
- Save. Note the application's **Application Audience (AUD) tag** — that value is
  `CF_ACCESS_AUDIENCE` (§2).

### 5.3 Write the allow policy

Add a policy on the application, **Action: Allow**, whose **Include** block is
the OR of:

- **Emails ending in** `@company.tld` — everyone in the corporate email domain.
- **Emails** — an explicit allowlist of individual addresses (e.g. specific
  `@gmail.com` accounts or external collaborators).

You can combine both selectors in one Include list (they are OR-ed), or manage
the explicit addresses through an Access **group** and Include that group.
Everyone who matches gets in; everyone else is blocked at the edge before the
request ever reaches the origin.

The verified email that Access puts in the JWT becomes the panel user (§2). The
first login by an address listed in `BOOTSTRAP_ADMIN_EMAILS` becomes an admin.

### 5.4 Wire the panel to Access (production env)

The **`infra/prod`** stack runs `control-api` with `NODE_ENV=production` already
set in `compose.yaml`; you supply the identity values in `infra/prod/.env`:

```
CF_ACCESS_ISSUER=https://<your-team>.cloudflareaccess.com
CF_ACCESS_AUDIENCE=<application AUD tag from §5.2>
BOOTSTRAP_ADMIN_EMAILS=you@company.tld,ops@company.tld
# POSTGRES_PASSWORD / CONFIG_ENCRYPTION_* / PANEL_IMAGE also in infra/prod/.env
```

The production `web` service carries **no** dev identity shim — it only forwards
the real `Cf-Access-Jwt-Assertion` header it receives from Access. (The dev-only
`x-dev-user-email` path is a stand-in for Access and must never be enabled in
production.)

> The `infra/prod` stack binds web/control-api to **loopback** (`5430`/`5431`) and
> never publishes postgres — see [`CLOUDFLARE-SETUP.md` §2](./CLOUDFLARE-SETUP.md).
> The dev-bind ports (`3000`/`3001`) in §1 apply to the local `infra/dev` stack.

### 5.5 Verify with the VPN OFF

From a network with **the VPN disconnected** (ideally a restricted/hostile
network), open `https://panel.<your-domain>`:

1. You should reach the **Cloudflare Access / Google login** — not a timeout.
   That proves the orange-cloud proxy is serving the panel independently of the
   VPN.
2. Sign in with an allowlisted Google account → the panel loads.
3. Sign in (or attempt to) with a non-allowlisted account → Access blocks you at
   the edge.
4. An address in `BOOTSTRAP_ADMIN_EMAILS` sees the admin nav (overview, users,
   nodes, routing).

If step 1 fails only when the VPN is off, the record is not truly proxied — fix
§4 before going live.

---

## 6. Credential types — do not mix these up

Two different Cloudflare credentials show up around Access, and they are **not**
interchangeable.

| | **Access service token** | **Cloudflare API token** |
| --- | --- | --- |
| Purpose | Authenticate a **machine** *through* an Access-protected app (skip the interactive Google login). | **Manage** Cloudflare resources — create/update Access apps and policies — via the REST API. |
| Presented as | Two custom request headers to the protected origin: `CF-Access-Client-Id` + `CF-Access-Client-Secret`. | `Authorization: Bearer <token>` to `https://api.cloudflare.com`. |
| Scope | One Access application, via a **Service Auth** policy that Includes the token. | Account/zone permissions, e.g. **Access: Apps and Policies — Edit**. |
| Manage the allowlist as code? | **No** — it only gets a client past a gate. | **Yes** — this is the one you need. |

So:

- To let a CI job or script call an endpoint that sits behind Access, mint a
  **service token** and add it to that app's policy (Service Auth). It never
  grants any management ability.
- To create/modify the Access application and its allowlist policy from code
  (§5 as API calls, and the `cloudflare` directory mode in
  [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md)), you need an **API token**
  with **Access: Apps and Policies: Edit** (add **Access: Organizations,
  Identity Providers, and Groups: Read** if you also resolve IdP/group IDs).
  This is exactly the `CF_API_TOKEN` the worker's optional Cloudflare
  reconcile mode consumes (`apps/worker/.env.example`) — a **Bearer API token,
  not a service token**.

The relevant REST endpoints (account-scoped, matching
[`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md)):

- `GET|POST /accounts/{account_id}/access/apps` — list / create Access
  applications (`type: "self_hosted"`, `domain: "panel.<your-domain>"`).
- `GET|POST /accounts/{account_id}/access/apps/{app_id}/policies` — the app's
  allow policy (`decision: "allow"`, `include: [{ email_domain: { domain:
  "company.tld" } }, { email: { email: "someone@gmail.com" } }]`).
- `/accounts/{account_id}/access/identity_providers` — the Google IdP.

---

## 7. Secrets handling

Every secret stays out of git. The repo enforces this with `.gitignore`
(`/secrets/`, `.env`, `.env.*` except `.env.example`, `infra/node/secrets/`,
`infra/node/state/`, `infra/node/backups/`), and `AGENTS.md` forbids committing,
logging, or quoting secret values.

| Secret | Lives in | Never |
| --- | --- | --- |
| Node-agent API key | `infra/node/secrets/node-agent-api-key` (mode `0640`, `root:root`) | in `.env`, a command line, or a log |
| Postgres password, config-encryption keyring | the app `.env` (`infra/dev/.env`, `apps/*/.env`) | committed |
| `CF_ACCESS_ISSUER` / `CF_ACCESS_AUDIENCE` | `apps/control-api/.env` | committed |
| `CF_API_TOKEN` (reconcile mode) | `apps/worker/.env` | committed; and it is an **API token**, not a service token (§6) |
| SSH key for the node tunnel | referenced by absolute path from `secrets/.secrets` | copied into the repo |

Redact VPN configs, QR payloads, private keys, API keys, and backups from any
command output or handoff.

---

### 7.1 Accepted risks (security audit, 2026-09-01)

Fixed from that audit: the `/api/control` proxy could be steered off the control
API origin with a `%2F`-smuggled segment (now rejected with 400, and only the
media types the control API emits are relayed); the host updater held its lock
on a container-writable path (now `/run/amnezia-panel`, opened read-only);
backups were world-readable (now `0600`/`0700`); the node API key had to be
passed on the CLI command line (now `--api-key-file=`); and node-agent command
failures could print an encoded `awg0.conf` — private key included — to
container stdout (now redacted).

Left as they are, deliberately — each sits inside the documented trust boundary:

| Item | Where | Why it is accepted |
| --- | --- | --- |
| Read-write Docker socket in the node-agent container | `infra/node/compose.yaml` | Load-bearing: the agent drives the AWG containers with `docker exec`, so the socket *is* the feature. Its compromise is already host-level (§1, `AGENT-HOST-SETUP.md`). Compensating controls: the agent stays loopback-only and the key file `0640 root:root`. Containing it properly needs a filtering socket proxy restricted to `exec` against the two AWG containers — a separate piece of infrastructure, tracked as its own backlog item. |
| `PostUp = <cmd>` in an operator-supplied `wgConfig` | node-agent `POST /server/backup` | Only a caller holding the node API key can supply a config, and that same key already grants `POST /server/reboot` and, through the socket above, root on the node. Blocking `PostUp` would break legitimate configs without narrowing what that caller can do. |
| Unauthenticated `/metrics` and Swagger UI | node-agent, loopback port only | Published on `127.0.0.1` (`infra/node/compose.yaml`); anything able to read them is already on the host and already holds the Docker socket. Adding auth here would not raise the bar. |

## 8. Infrastructure-as-code direction (not implemented yet)

Today the Access application, its Google IdP, and the allow policy are set up by
hand (dashboard clicks or ad-hoc API calls), and the repo carries only the
**consumption** side of Access (JWT verification in the control-api, and the
optional worker reconcile whose Cloudflare directory mode is a documented
extension point in [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md), intentionally
left unimplemented).

The forward-looking recommendation: **capture the Access configuration as code**
so the next app you put behind Access is one command, not a click-path.

- **REST API scripts** — the `/accounts/{account_id}/access/apps` and
  `.../policies` endpoints from §6, driven by an **Access: Apps and Policies:
  Edit** API token, are enough to create the app + policy repeatably.
- **Terraform** — the `cloudflare` provider models the same objects
  (`cloudflare_zero_trust_access_application`,
  `cloudflare_zero_trust_access_policy`,
  `cloudflare_zero_trust_access_identity_provider`), which keeps the app,
  policy, IdP, and allowlist under review and version control.

This is a direction, not a shipped feature: no Terraform or provisioning scripts
exist in the tree yet, and the worker's Cloudflare reconcile still throws until
its `getAllowedEmails()` is wired (see `CLOUDFLARE-ACCESS.md`). Keep the
empty-result guard when you implement either, so a failed lookup skips instead of
deactivating everyone.

---

## 9. End-to-end verification checklist

- [ ] Node healthy in **Админ → VPN-ноды** (green, recent `lastSyncAt`, both
      protocols) — see [`NODE-CONNECT.md` §4](./NODE-CONNECT.md).
- [ ] `panel.<your-domain>` opens the Access/Google login **with the VPN OFF** (§5.5).
- [ ] Allowlisted Google account signs in; non-allowlisted is blocked at the edge.
- [ ] A `BOOTSTRAP_ADMIN_EMAILS` address gets the admin nav.
- [ ] Create a key (defaults to **AWG 3.1**), import it in AmneziaVPN 5.0.1.5+,
      confirm handshake and traffic — [`AGENT-HOST-SETUP.md` Part D](./AGENT-HOST-SETUP.md).
- [ ] *(Optional)* access-reconcile enabled and validated —
      [`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md).

---

## Related documents

- [`docs/ROLLOUT.md`](./ROLLOUT.md) — the end-to-end rollout (Cloudflare + nodes + panel).
- [`docs/AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — full node + control-plane
  install runbook.
- [`docs/NODE-CONNECT.md`](./NODE-CONNECT.md) — connecting a node.
- [`docs/CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) — access-removal
  reconcile.
- [`docs/SMALL-HOSTS.md`](./SMALL-HOSTS.md) — running the stack on a 512 MB - 1 GB
  box: swap, task budgets, Postgres sizing, disk reclamation.
