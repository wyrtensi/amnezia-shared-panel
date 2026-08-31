# Cloudflare setup: deploy Amnezia Panel behind Access + Google

End-to-end runbook to expose the panel at **`panel.example.com`** on the
existing Linux box **`203.0.113.10`** — behind a Cloudflare Tunnel and
Cloudflare Access (Google login, email allowlist) — **without opening any inbound
port** and **without touching** the VPN stack already on that box
(`amnezia-awg3` UDP 51890, `amnezia-awg2` UDP 51889, `shadowbox`, `watchtower`,
`node-agent` on `127.0.0.1:4001`).

This ties together the pieces the other docs own — see
[`docs/HOSTING.md`](./HOSTING.md) (raise order),
[`docs/CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) (Access app detail +
two-way sync), and [`docs/DEPLOY-UPDATE.md`](./DEPLOY-UPDATE.md) (updates).

---

## Deploy specifics for this setup (authoritative)

> This deployment uses **`infra/prod/compose.yaml`** + **`infra/prod/.env`** (copy
> from `.env.example`) — NOT the `infra/dev` + override approach described later.
> Anywhere a later section says `infra/dev` / `compose.prod.yaml` / port `3000`,
> read **`infra/prod/compose.yaml`** / port **`5430`**.

**Shared machine — do NOT disturb what's already running.** The box may host other
Amnezia clients/servers (`amnezia-awg2`, `amnezia-awg3`, `shadowbox`, `watchtower`,
`node-agent`) and possibly other tenants. **Never stop, remove, or re-port them.**
The panel comes up as its own Compose project (`amnezia-panel`) on **uncommon
loopback ports** so nothing collides — defaults `5430` (web) / `5431` (control-api),
both overridable in `infra/prod/.env` (`WEB_PUBLISH_PORT` / `CONTROL_API_PUBLISH_PORT`).
Postgres is never published. Pick any free ports for our project; the Amnezia
containers keep theirs.

**Co-located node (panel + Amnezia node on one machine).** Supported. The panel's
containers get a `host.docker.internal` route (`infra/prod/compose.yaml`), so a
node-agent listening on the host (e.g. `127.0.0.1:4001`) is reachable — register
that node in the panel with **`apiBaseUrl: http://host.docker.internal:4001`**.

## TL;DR

- **Point the domain at `http://localhost:5430`** — the `web` container, published
  on host loopback as `127.0.0.1:5430` (`infra/prod/compose.yaml`; override with
  `WEB_PUBLISH_PORT`). **Not** the control-api port, **not 443** (TLS terminates at
  Cloudflare's edge).
- **Transport is one Cloudflare Tunnel** (`cloudflared`, run as a host systemd
  service): `panel.example.com` → `http://localhost:5430`. Zero inbound ports;
  the awg/shadowbox/node-agent stack is left exactly as-is.
- **Runtime token the panel needs = one group:** **`Access: Apps and Policies` —
  Edit**, **Account**-scoped to your one account, nothing else — and only if you
  turn on the panel→Access write-back. The **login/JWT path needs no token at
  all** (just the public `CF_ACCESS_ISSUER` + `CF_ACCESS_AUDIENCE`).
- **Bootstrap token** (only for a future "agent creates the app + Google IdP from
  scratch") adds **`Access: Organizations, Identity Providers, and Groups` — Edit**
  on top; not needed once the app exists.

---

## Placeholders

Fill these with your real values; the repo hardcodes none of them.

| Placeholder | What it is | Where it comes from |
| --- | --- | --- |
| `<TEAM>` | Zero Trust team name → `https://<TEAM>.cloudflareaccess.com` | Zero Trust → Settings → Custom Pages / team domain |
| `<ACCOUNT_ID>` | Cloudflare account ID | Any account URL, or the app's API details |
| `<APP_ID>` | The Access application UUID | The app's Overview after you create it |
| `<POLICY_ID>` | The Allow policy UUID | The policy row on the app, or the policies API |
| `<AUD>` | The application Audience (AUD) tag → `CF_ACCESS_AUDIENCE` | The app's Overview / Settings |
| `<GOOGLE_IDP_ID>` | The Google IdP UUID | Response of the IdP-create call / IdP list |
| `<GOOGLE_CLIENT_ID>` / `<GOOGLE_CLIENT_SECRET>` | Google OAuth client credentials | Google Cloud Console → Credentials |

Fixed for this deployment: domain `panel.example.com`, zone
`example.com`, origin host `203.0.113.10`.

---

## 1. Prerequisites

**On Cloudflare (one-time, dashboard/Google-side — these are not API operations):**

1. **A Cloudflare account** with the **`example.com` zone** already added, so
   Cloudflare can auto-write the tunnel's DNS record for `panel.example.com`.
2. **Zero Trust enabled** on the account — pick a team name and select a plan
   (the **Free** plan is fine). Choosing the plan / entering billing is a one-time
   dashboard step at `one.dash.cloudflare.com`; it cannot be done via API. This
   gives you the team domain `https://<TEAM>.cloudflareaccess.com`.
3. **A Google Cloud OAuth 2.0 client** (type *Web application*) in
   **Google Cloud Console → APIs & Services → Credentials → OAuth client ID**:
   - **Authorized JavaScript origin:** `https://<TEAM>.cloudflareaccess.com`
   - **Authorized redirect URI:** `https://<TEAM>.cloudflareaccess.com/cdn-cgi/access/callback`
   - Copy the **Client ID** and **Client secret** — you enter these once into
     Cloudflare (step 4.1) and never commit them.

**On the origin host `203.0.113.10`:**

4. **Docker + Docker Compose v2** installed. The existing VPN stack already uses
   Docker, so this is typically present.
5. **Outbound HTTPS/QUIC (443) allowed** to Cloudflare — that is the only
   connectivity the tunnel needs. **No inbound port is opened.**

> **Untouched-by-construction:** everything the panel adds runs as its own
> compose project and one isolated outbound-only daemon. You will not edit any
> firewall rule, and you will not touch the `amnezia-awg2` / `amnezia-awg3` /
> `shadowbox` / `watchtower` / `node-agent` containers or their ports.

---

## 2. Deploy the panel on the server (compose)

The control plane is the `infra/dev` compose stack: `postgres`, `migrate`,
`control-api` (`127.0.0.1:3001`), `worker`, and `web` (`127.0.0.1:3000`). Both
public-facing ports bind to **loopback only** — the tunnel reaches them over
`localhost`, nothing is exposed to the internet.

### 2.1 Get the code and prepare the env file

```sh
git clone <your-panel-repo> /opt/amnezia-panel
cd /opt/amnezia-panel/infra/dev
cp .env.example .env
```

Edit `infra/dev/.env` and replace every placeholder with real secrets:

```sh
# infra/dev/.env
POSTGRES_PASSWORD=<long-random-password>
DATABASE_URL=postgres://amnezia_panel:<long-random-password>@postgres:5432/amnezia_panel
# 32-byte key, base64. Generate with:  openssl rand -base64 32
CONFIG_ENCRYPTION_KEYS_JSON={"1":"<base64-32-byte-key>"}
CONFIG_ENCRYPTION_ACTIVE_VERSION=1
DEV_USER_EMAIL=admin@example.com   # unused in production; harmless
```

The DB is never published to the host; the `DATABASE_URL` host is the compose
service name `postgres`.

### 2.2 Add the production override (turns OFF dev identity)

The base `infra/dev/compose.yaml` hard-codes **development** identity in the
service `environment:` blocks (`NODE_ENV: development`, `ALLOW_DEV_IDENTITY:
"true"` on `control-api`; `DEV_IDENTITY_ENABLED: "true"` on `web`). A compose
`environment:` entry overrides `env_file`, so you **cannot** flip these from
`.env` — you override them with a second compose file. Create
`infra/dev/compose.prod.yaml`:

```yaml
# infra/dev/compose.prod.yaml — production identity overrides.
name: amnezia-panel
services:
  control-api:
    environment:
      NODE_ENV: production
      ALLOW_DEV_IDENTITY: "false"
      # From section 4 (Access application):
      CF_ACCESS_ISSUER: https://<TEAM>.cloudflareaccess.com
      CF_ACCESS_AUDIENCE: <AUD>
      # First login by these emails becomes admin (comma-separated, lower-cased):
      BOOTSTRAP_ADMIN_EMAILS: you@example.com,ops@example.com
  web:
    environment:
      # Drop the dev header shim; web forwards only the real Access JWT.
      DEV_IDENTITY_ENABLED: "false"
```

With `NODE_ENV=production`, `apps/control-api/src/main.ts` builds the Cloudflare
Access adapter and **requires** `CF_ACCESS_ISSUER` + `CF_ACCESS_AUDIENCE` (it
throws at boot if either is missing), and the `x-dev-user-email` shim is disabled
regardless of `ALLOW_DEV_IDENTITY`. You can fill the two `CF_ACCESS_*` values now
if you already have them, or come back after section 4.

### 2.3 Bring the stack up

```sh
cd /opt/amnezia-panel/infra/dev
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env up -d --build
```

`migrate` runs once, then `control-api`, `worker`, and `web` start. Verify from
the box itself (loopback):

```sh
curl -fsS http://127.0.0.1:3001/healthz && echo OK        # control-api
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/   # web
docker compose -f compose.yaml -f compose.prod.yaml ps
```

This project is named `amnezia-panel` and is fully separate from the VPN
compose stacks. Its image is built locally (`amnezia-panel/app:dev`), so
watchtower has no registry tag to pull and will not update it. No inbound port
was opened.

---

## 3. Domain + Cloudflare Tunnel

**What port do I point the domain to? → `http://localhost:3000`.** That is the
`web` container on `127.0.0.1:3000`. You do **not** create an `A` record to
`203.0.113.10`, and you open **no** inbound port. You install `cloudflared` on
the box, create one tunnel, and route `panel.example.com` →
`http://localhost:3000`. Cloudflare writes the DNS for you.

Why the tunnel here: `cloudflared` dials **outbound-only** (QUIC/HTTPS 443) to
Cloudflare and holds the connection open. Consequences: **zero inbound ports**
(the box firewall is untouched, awg/shadowbox/node-agent keep their exact
exposure), the **origin IP stays hidden**, and it runs as its **own systemd
service** — outside watchtower's scope and both amnezia compose stacks.

### 3.1 Create the tunnel + public hostname (dashboard, recommended)

In `one.dash.cloudflare.com` → **Networks → Tunnels**:

1. **Create a tunnel** → connector **Cloudflared** → name e.g. `forget-panel`.
2. Copy the shown one-line **install command** (it embeds the tunnel token) and
   run it on `203.0.113.10`. It installs and enables `cloudflared.service`; the
   connector then shows **HEALTHY**.
3. Open the tunnel's **Public Hostname** tab → **Add a public hostname**:
   - **Subdomain** `forget`  **Domain** `example.com`  **Path** *(empty)*
   - **Service:** Type **HTTP**, URL **`localhost:3000`**

The service URL **is** where the domain points — that is the whole "point the
domain" step.

**Locally-managed equivalent** (config on the box instead of the dashboard):

```yaml
# /etc/cloudflared/config.yml
tunnel: <TUNNEL-UUID>
credentials-file: /etc/cloudflared/<TUNNEL-UUID>.json
ingress:
  - hostname: panel.example.com
    service: http://localhost:3000
  - service: http_status:404
```

```sh
cloudflared tunnel login
cloudflared tunnel create forget-panel
cloudflared tunnel route dns forget-panel panel.example.com   # creates the CNAME
cloudflared service install                                       # runs as cloudflared.service
```

### 3.2 The DNS record Cloudflare auto-creates (do not hand-edit)

Saving the public hostname (or `tunnel route dns`) writes a **proxied** record in
the `example.com` zone:

```
panel.example.com   CNAME   <TUNNEL-UUID>.cfargotunnel.com   (Proxied / orange cloud)
```

The orange cloud is required: the hostname resolves to Cloudflare, so the panel
is reachable **with the VPN off** and Access can sit in front. (`example.com`
must be a zone in the same account, per section 1.)

### 3.3 The one gotcha

Run `cloudflared` **on the host** (systemd), so `http://localhost:3000` resolves
to the loopback-published `web` port. If you instead run it in a container,
`localhost` is that container — you would need
`http://host.docker.internal:3000` (`--add-host host.docker.internal:host-gateway`)
or attach to the panel network and use `http://web:3000`. Running on the host
avoids all of it and is the recommended shape.

---

## 4. Create the Access application + Google login

All of this is edge/dashboard-side; none of it touches `203.0.113.10` or its VPN
containers. It yields the two panel env values:

| Panel env var | Value | Consumed by |
| --- | --- | --- |
| `CF_ACCESS_ISSUER` | `https://<TEAM>.cloudflareaccess.com` | `apps/control-api/src/cloudflareAccess.ts` (fetches JWKS at `<issuer>/cdn-cgi/access/certs`, checks `iss`) |
| `CF_ACCESS_AUDIENCE` | `<AUD>` (the application's AUD tag) | same file (checks `aud`); required by `main.ts` in production |

For the API calls, `$CF_API_TOKEN` is a **Bearer management token** (see section
6), and `BASE="https://api.cloudflare.com/client/v4"`.

### 4.1 Add Google as an identity provider

**Dashboard:** Zero Trust → **Settings → Authentication → Login methods → Add new
→ Google.** Paste the Google **Client ID** + **Client secret** from section 1 →
**Save** → **Test**.

**API:**
```sh
curl -s -X POST "$BASE/accounts/<ACCOUNT_ID>/access/identity_providers" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" \
  --data '{
    "name": "Google",
    "type": "google",
    "config": { "client_id": "<GOOGLE_CLIENT_ID>", "client_secret": "<GOOGLE_CLIENT_SECRET>" }
  }'
```
Response `result.id` = `<GOOGLE_IDP_ID>` (pins the app to Google in step 4.2). Use
`"type": "google"` for individual/Gmail accounts; `"google-apps"` (with
`config.apps_domain`) only to lock login to one Workspace domain at the IdP layer.

### 4.2 Create the self-hosted application

**Dashboard:** Zero Trust → **Access → Applications → Add an application →
Self-hosted:**

1. **Application name:** `Amnezia Panel`.
2. **Destinations → Public hostname:** subdomain `forget`, domain `example.com`,
   **Path empty**. Add no second hostname.
3. **Session Duration:** `1 week`.
4. **Identity providers:** select **Google** only; **Accept all identity
   providers: OFF**; **Instant Auth: ON** (with one IdP this skips the picker and
   goes straight to Google).
5. Add one **Allow** policy (step 4.3), then **Save**.

**API** (`allowed_idps` pins Google; `auto_redirect_to_identity` = Instant Auth;
`168h` = 1 week; the inline policy is the app-scoped Allow policy the worker later
reads/writes):
```sh
curl -s -X POST "$BASE/accounts/<ACCOUNT_ID>/access/apps" \
  -H "Authorization: Bearer $CF_API_TOKEN" -H "content-type: application/json" \
  --data '{
    "name": "Amnezia Panel",
    "type": "self_hosted",
    "domain": "panel.example.com",
    "destinations": [{ "type": "public", "uri": "panel.example.com" }],
    "session_duration": "168h",
    "allowed_idps": ["<GOOGLE_IDP_ID>"],
    "auto_redirect_to_identity": true,
    "app_launcher_visible": false,
    "policies": [
      {
        "name": "Amnezia Panel management",
        "decision": "allow",
        "precedence": 1,
        "include": [
          { "email_domain": { "domain": "example.com" } },
          { "email": { "email": "you@example.com" } }
        ]
      }
    ]
  }'
```
From `result`: `id` → `<APP_ID>`, `aud` → **`<AUD>` = `CF_ACCESS_AUDIENCE`**,
`policies[0].id` → `<POLICY_ID>`. (If a build rejects inline `policies`, create
with `"policies": []` then `POST $BASE/accounts/<ACCOUNT_ID>/access/apps/<APP_ID>/policies`
with the same `{name,decision,include}` body — the exact endpoint the worker
targets.)

### 4.3 Restrict to specific emails / domains

The Allow policy's `include` array is the allowlist (logical **OR** — match any
rule and you are in; match none and you are blocked at the edge):

- **Whole domain:** `{ "email_domain": { "domain": "example.com" } }`
- **One address:** `{ "email": { "email": "person@gmail.com" } }`

Leave `exclude` and `require` empty for the basic model. Later the panel can
author this same list itself (write-back, section 6 / Direction 2 in
[`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md)).

### 4.4 Read back `CF_ACCESS_ISSUER` and `CF_ACCESS_AUDIENCE`

- **Issuer / team domain — Dashboard:** Zero Trust → Settings → Custom Pages →
  team domain shows `<TEAM>.cloudflareaccess.com`. **API:**
  ```sh
  curl -s "$BASE/accounts/<ACCOUNT_ID>/access/organizations" \
    -H "Authorization: Bearer $CF_API_TOKEN" | grep -o '"auth_domain":"[^"]*"'
  ```
  Set `CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com` (no trailing slash;
  the code strips one anyway).
- **AUD tag — Dashboard:** Access → Applications → Amnezia Panel → Overview →
  **Application Audience (AUD) Tag**. **API** (if not captured from 4.2):
  ```sh
  curl -s "$BASE/accounts/<ACCOUNT_ID>/access/apps/<APP_ID>" \
    -H "Authorization: Bearer $CF_API_TOKEN" | grep -o '"aud":"[^"]*"'
  ```
  Set `CF_ACCESS_AUDIENCE=<AUD>`.

---

## 5. Configure the panel env with those values

Put the two values from section 4 into `infra/dev/compose.prod.yaml` (section 2.2)
under `control-api.environment`, then recreate that service:

```yaml
    environment:
      NODE_ENV: production
      ALLOW_DEV_IDENTITY: "false"
      CF_ACCESS_ISSUER: https://<TEAM>.cloudflareaccess.com
      CF_ACCESS_AUDIENCE: <AUD>
      BOOTSTRAP_ADMIN_EMAILS: you@example.com,ops@example.com
```

```sh
cd /opt/amnezia-panel/infra/dev
docker compose -f compose.yaml -f compose.prod.yaml --env-file .env up -d --build
```

`BOOTSTRAP_ADMIN_EMAILS` (comma-separated, lower-cased) promotes the first Google
login that lands to `admin` — there is no seed script. Keep the `web` dev shim
off (`DEV_IDENTITY_ENABLED: "false"`).

**Smoke test — with the VPN OFF**, open `https://panel.example.com`:

1. You are bounced to **Google** (proves off-VPN reachability through the proxy).
2. Only an allowlisted email returns to the panel; a non-listed Google account is
   blocked by Access before the origin.
3. A `BOOTSTRAP_ADMIN_EMAILS` address sees the admin nav.

On success Access injects `Cf-Access-Jwt-Assertion`, `apps/web` forwards it, and
control-api verifies it. A `401 INVALID_IDENTITY_TOKEN` means an issuer/audience
mismatch — recheck section 4.4.

---

## 6. The two API tokens

Both are **Cloudflare API tokens** (`Authorization: Bearer …` to
`api.cloudflare.com`), created at **My Profile → API Tokens → Create Token →
Custom token**, always **Account Resources → Include → your specific account**
(`<ACCOUNT_ID>`), never "All accounts".

> **Not** an Access **service token.** A service token
> (`CF-Access-Client-Id` ending `.access` + `CF-Access-Client-Secret` starting
> `cfast_`) only gets a machine *past* the Access gate and grants **zero**
> management ability. Do not use one here.

### 6.1 Runtime token (least privilege) — what the running panel needs

**Exactly one permission group:** **`Access: Apps and Policies` — Edit**, at
**Account** scope. Nothing else.

| Runtime function (`apps/worker/src/cloudflareApi.ts`) | HTTP call | Group |
| --- | --- | --- |
| `getPolicy()` | `GET …/access/apps/<APP_ID>/policies/<POLICY_ID>` | `Access: Apps and Policies` — Read |
| `updatePolicy()` | `PATCH …/access/apps/<APP_ID>/policies/<POLICY_ID>` | `Access: Apps and Policies` — **Edit** |

Both hit the same one policy resource, built directly from the configured
`appId`/`policyId` — the client never lists apps/policies and never
creates/deletes. **Edit implies Read**, so the single Edit group covers both
calls; there is no tighter *named* account group that grants `PATCH`.

- **Where it is used:** only by the worker's **panel→Access write-back**
  (`ACCESS_WRITEBACK_ENABLED=true` in `apps/worker/.env`). The write-back reads
  the token + account/app/policy IDs from the **panel admin settings**, stored
  **encrypted at rest and write-only** — not from a committed `.env`.
- **The login/JWT path needs no token.** `cloudflareAccess.ts` fetches the
  **public** JWKS at `<issuer>/cdn-cgi/access/certs`; it consumes only
  `CF_ACCESS_ISSUER` + `CF_ACCESS_AUDIENCE` (public config, not secrets).
- **Keep off the token:** any Zone permission (DNS/WAF), `Account Settings`,
  `Cloudflare Tunnel`, `Access: Service Tokens`, and
  `Access: Organizations, Identity Providers, and Groups` — the runtime resolves
  no IdP/group IDs in code (the `cloudflare` reconcile directory is an
  unimplemented stub; default `ACCESS_DIRECTORY=allowlist` needs no token).
- **Tightest option:** Cloudflare's Feb-2026 resource-scoped roles (beta) include
  an *Access policy admin* role scopable to a **single** policy — strictly tighter
  than the account-wide group. Use it if you are comfortable on beta; otherwise
  the account-scoped **`Access: Apps and Policies` — Edit** is the correct floor.
- Optional hardening: an IP-allowlist condition (the box's egress IP) and a
  rotation TTL.

### 6.2 Bootstrap token (all-access) — only to auto-create the app + IdP

For a future "agent builds the Access app from scratch" flow (section 7). It is a
**superset** of the runtime token — two Account-scoped groups:

| Permission group (dashboard label / API name) | Which bootstrap step needs it |
| --- | --- |
| **`Access: Apps and Policies` — Edit** (`Access: Apps and Policies Write`) | Create the application; create the Allow policy |
| **`Access: Organizations, Identity Providers, and Groups` — Edit** (`…Write`) | Create/verify the Zero Trust org; create the Google IdP; create a rule **group** if the policy references one |

- **Watch-out:** a reusable Access **rule group** (`/access/groups`) is covered by
  the *Organizations, Identity Providers, and Groups* group — **not** by *Apps and
  Policies*. A common trip-up if "allow a Google-authenticated group" means a
  Cloudflare rule group.
- **Adjacent (optional), for a truly end-to-end raise that also creates/proxies
  the DNS record:** add **DNS — Edit** (Zone-scoped, the `example.com` zone) +
  **Zone — Read** (to resolve the zone id). Not needed with the tunnel flow in
  section 3, which auto-writes the CNAME.
- `Access: Service Tokens` is **not** needed.

---

## 7. Future: agent auto-creates the Access app + Google IdP

The panel today only **consumes** Access (JWT verification in control-api, plus
the optional write-back). A bootstrap agent could create the whole gate with the
section-6.2 token. Endpoints in dependency order (base
`https://api.cloudflare.com/client/v4`, **IdP before App**, **App before Policy**):

| Step | Method + path | Perm group |
| --- | --- | --- |
| 0. Zero Trust org / team domain | `GET`/`POST` `/accounts/<ACCOUNT_ID>/access/organizations` | Orgs/IdPs/Groups — Edit |
| 2. Google IdP → `<GOOGLE_IDP_ID>` | `POST` `/accounts/<ACCOUNT_ID>/access/identity_providers` | Orgs/IdPs/Groups — Edit |
| 1. Self-hosted app → `<APP_ID>`, `<AUD>` | `POST` `/accounts/<ACCOUNT_ID>/access/apps` | Apps and Policies — Edit |
| 3. Allow policy → `<POLICY_ID>` | `POST` `/accounts/<ACCOUNT_ID>/access/apps/<APP_ID>/policies` (or account-level `/access/policies` for a reusable one) | Apps and Policies — Edit |
| 3b. Rule group (only if referenced) | `POST` `/accounts/<ACCOUNT_ID>/access/groups` | Orgs/IdPs/Groups — Edit |

The request bodies are exactly those in section 4 (4.1 IdP, 4.2 app, 4.3 policy).
Two hard inputs the token **cannot** substitute for: the Google OAuth
`client_id`/`client_secret` (minted in Google Cloud Console) and a Zero-Trust-
onboarded account (first-time plan selection is dashboard-only). Once steps 0–1
run, they produce the `CF_ACCESS_ISSUER` + `CF_ACCESS_AUDIENCE` that section 5
wires in, and step 3 produces the `<APP_ID>`/`<POLICY_ID>` the runtime write-back
(section 6.1) then maintains — see
[`CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) Direction 2.

---

## Verify

1. `systemctl status cloudflared` on `203.0.113.10` → active; the tunnel shows
   **HEALTHY** in the dashboard.
2. `docker compose -f compose.yaml -f compose.prod.yaml ps` → all panel services
   up; `curl http://127.0.0.1:3000/` on the box returns 200.
3. From a network **with the VPN off**, `https://panel.example.com` lands on
   the Cloudflare Access / Google screen, then the panel loads for an allowlisted
   account; a non-listed account is blocked at the edge.
4. `awg` handshakes, shadowbox, and node-agent are unaffected — no firewall rule
   was changed and no inbound port was opened.

## Related documents

- [`docs/HOSTING.md`](./HOSTING.md) — top-level raise order and architecture.
- [`docs/CLOUDFLARE-ACCESS.md`](./CLOUDFLARE-ACCESS.md) — Access app detail,
  allowlist, and two-way panel↔Access sync (write-back + deactivation reconcile).
- [`docs/DEPLOY-UPDATE.md`](./DEPLOY-UPDATE.md) — updating the panel stack and node.
