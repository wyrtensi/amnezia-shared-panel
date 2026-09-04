# Cloudflare Access: application, allowlist, and two-way sync

This guide has two parts:

- **Part A — Create the Access application.** A click-by-click for the
  self-hosted Access app that fronts the panel: one public hostname, one Allow
  policy backed by an email allowlist, Google as the only login method.
- **Part B — Two-way sync (panel ↔ Access allowlist).** How the panel and the
  Access allowlist stay in step in both directions — Access removals
  deactivating panel accounts (scaffolded, gated) and panel changes writing back
  to the Access policy (the exact Cloudflare API calls and the token they need).

It assumes the panel is already reachable through the Cloudflare proxy and that
identity verification is wired — see [`docs/HOSTING.md`](./HOSTING.md) for the
end-to-end raise (proxy, Google IdP, production env). This doc is the detail
behind that guide's §5–§6.

> The straightforward-path rule applies: if a step cannot be completed as
> written, stop and report the blocker rather than inventing a Cloudflare field
> or endpoint.

## Placeholders used below

Fill these in with your real values; the repo hardcodes none of them.

| Placeholder | What it is | Where it comes from |
| --- | --- | --- |
| `<PANEL_DOMAIN>` | The panel's public hostname, e.g. `panel.company.tld`. Not chosen yet — front it with the server's public IP for now and set a real subdomain later. | You pick it; it must be proxied by Cloudflare (orange cloud). |
| `<TEAM>` | Your Zero Trust team name → `https://<TEAM>.cloudflareaccess.com`. | Zero Trust → Settings → Custom Pages / team domain. |
| `<ACCOUNT_ID>` | Cloudflare account ID. | Any account URL, or the app's API details. |
| `<APP_ID>` | The Access application's UUID. | The app's **Overview / Details** after you create it. |
| `<POLICY_ID>` | The Allow policy's UUID. | The policy row on the app, or the policies API. |
| `<AUD>` | The application **Audience (AUD) tag**. | The app's **Overview / Settings** → `CF_ACCESS_AUDIENCE`. |
| `company.tld` | Your corporate email domain. | Your organization. |

---

## Part A — Create the Access application

This mirrors the shape used for any other self-hosted app behind Access: one
hostname, a single Allow policy whose rule is an **email allowlist**, and
**Google Workspace** as the sole login method. Reproduce that shape for the panel.

> **The Google Workspace IdP is shared across every app on the account.** If the
> account already has a working Google login method, **reference** it — do not
> create a duplicate and do not edit the shared IdP to suit this app (editing it
> affects every application that uses it). Likewise the Zero Trust **team domain**
> (`<TEAM>.cloudflareaccess.com`) is one per account and shared by all apps; each
> app is isolated only by its own **AUD** and its own policy.

Everything here is the Zero Trust dashboard
(`https://one.dash.cloudflare.com` → your account → **Access**). The equivalent
REST calls are in Part B and in [`HOSTING.md` §6](./HOSTING.md).

### A.0 Prerequisites

- **Google identity provider added** to Zero Trust
  (**Settings → Authentication → Login methods → Add new → Google**, with a
  Google Cloud OAuth client ID + secret). This is **Google Workspace / Google**
  as an IdP; it must exist before the app can reference it.
- **`<PANEL_DOMAIN>` is proxied by Cloudflare** (orange cloud) so the panel is
  reachable off-VPN — see [`HOSTING.md` §4](./HOSTING.md). Until you own a
  subdomain, this can be the server's public IP fronted by Cloudflare; swap in a
  real hostname later and update the app's destination.

### A.1 Add a self-hosted application

**Access → Applications → Add an application → Self-hosted.**

- **Application name:** e.g. `Amnezia Panel`.

### A.2 Destinations — one public hostname, no path

Under **Destinations → Public hostnames**, add exactly one entry:

- **Subdomain + Domain:** the two halves of `<PANEL_DOMAIN>` (e.g. subdomain
  `panel`, domain `company.tld`). If you are fronting the raw IP for now, use
  whatever hostname Cloudflare proxies to it.
- **Path:** leave **empty**. The whole panel sits behind Access; there is no
  public sub-path that should bypass it.

Do not add a second hostname or a private-network destination — the panel is a
single public origin.

### A.3 Access policy — a single Allow policy backed by an email allowlist

Add **one** policy to the application:

- **Policy name:** e.g. `Amnezia Panel management`.
- **Action:** **Allow**.
- **Session duration:** inherits the app default (A.5) unless you override it.
- **Configure rules → Include:** build the allowlist. The model is the **OR** of:
  - **Emails ending in** `@company.tld` — everyone in the corporate email
    domain, in one rule; **plus**
  - **Emails** — an explicit list of individual addresses (external
    collaborators, specific `@gmail.com` accounts, etc.).

Everyone who matches any Include rule gets in; everyone else is blocked at the
edge before the request reaches the origin. Leave **Exclude** and **Require**
empty for the basic model.

The reference app the operator provided is an **Allow / Include: Emails**
policy — a flat allowlist of individual addresses. As JSON (the shape Part B
reads and writes), that real example is exactly:

```json
{
  "name": "Amnezia Panel management",
  "decision": "allow",
  "include": [
    { "email": { "email": "admin@company.tld" } },
    { "email": { "email": "person@gmail.com" } }
  ],
  "exclude": [],
  "require": []
}
```

**The model** is that same allowlist with a corporate-domain rule added
alongside the explicit addresses — everyone in `@company.tld` in one rule, plus
named external accounts:

```json
"include": [
  { "email_domain": { "domain": "company.tld" } },
  { "email": { "email": "admin@company.tld" } },
  { "email": { "email": "person@gmail.com" } }
]
```

- A specific address is `{ "email": { "email": "person@gmail.com" } }`.
- The corporate-domain rule is `{ "email_domain": { "domain": "company.tld" } }`
  ("emails ending in @company.tld").

You can keep the explicit addresses in this Include list, or manage them through
an Access **group** / **reusable policy** and Include that instead (Part B
covers writing to either).

### A.4 Login methods — Google only, instant auth on

On the application's **login methods**:

- **Identity providers:** select **Google** (the Google Workspace IdP from A.0).
- **Accept all identity providers:** **OFF** — do not accept every configured
  IdP; pick just Google, so the panel has one identity source.
- **Apply instant authentication (Instant Auth):** **ON**. With a single login
  method, Instant Auth skips the "choose your identity provider" screen and
  sends the user straight to Google. (It only has an effect while exactly one IdP
  is selected; adding a second brings the picker back.)

### A.5 Session duration — 1 week

Set the application **Session Duration** to **1 week**. Users re-authenticate
weekly rather than on every visit.

> Note: a **policy-level** session duration, or a shorter **global** Zero Trust
> session (Settings → Authentication), can override the app value — the shortest
> applicable session wins. If sessions expire sooner than a week, check those two
> places.

### A.6 What the panel does with the verified identity

Once Access lets a request through, it injects a signed
**`Cf-Access-Jwt-Assertion`** header. The panel does **not** trust the proxy
blindly:

1. `apps/web` forwards the header to the control-api.
2. `apps/control-api/src/cloudflareAccess.ts` **cryptographically verifies** the
   JWT — fetches Cloudflare's JWKS from `<issuer>/cdn-cgi/access/certs`, checks
   `issuer`, `audience` (`<AUD>`), and `RS256`, then reads the `email` claim
   (lower-cased) as the user identity. Missing `sub`/`email` → `401`.
3. First request from a new email auto-provisions a panel user. If that email is
   in **`BOOTSTRAP_ADMIN_EMAILS`** (control-api env, comma-separated,
   lower-cased) the account is promoted to `admin`. This is how the first
   admin(s) exist — there is no seed script.

The two production env vars this needs (`apps/control-api/.env`) are
`CF_ACCESS_ISSUER=https://<TEAM>.cloudflareaccess.com` and
`CF_ACCESS_AUDIENCE=<AUD>`. See [`HOSTING.md` §2 and §5.4](./HOSTING.md).

### A.7 Record the IDs you will need in Part B

From the application's **Overview / Details** page (and its policy row), copy:

- **Audience (AUD) tag** → `<AUD>` → `CF_ACCESS_AUDIENCE`.
- **Application ID** (UUID) → `<APP_ID>`.
- **Policy ID** (UUID) of the Allow policy → `<POLICY_ID>`.
- **Account ID** → `<ACCOUNT_ID>`.

Part B's write-back sync is driven entirely by `<ACCOUNT_ID>`, `<APP_ID>`, and
`<POLICY_ID>`.

---

## Part B — Two-way sync (panel ↔ Access allowlist)

Access and the panel each hold a notion of "who may use the panel," and they can
drift apart. Two **independent** directions keep them aligned; you can enable
either without the other.

| Direction | Trigger | Effect | Status |
| --- | --- | --- | --- |
| **1. Access → panel** | Someone is removed from the Access allowlist. | The panel deactivates their account and revokes their VPN keys. | Scaffolded in the worker, **gated off** by default. |
| **2. panel → Access** | An admin adds/removes a user in the panel. | The panel adds/removes that email in the Access Allow policy `include` list. | Design + exact API calls below; write-back is the forward-looking half. |

Why both are needed: removing someone from Access stops them **signing in**, but
it does **not** revoke their VPN keys — keys work independently of the login
session (Direction 1 closes that). And adding a user in the panel does not by
itself let them past the edge — Access must also allow their email (Direction 2
closes that).

### Recommended: `ACCESS_SYNC_ENABLED` — both directions, one task

The correct, forward-looking wiring is a **single** worker task that reconciles
the panel's active users against the Access policy `include` list in **both**
directions on each run — `createAccessSync` in
`apps/worker/src/accessReconcile.ts`. Turn it on with one switch:

```
ACCESS_SYNC_ENABLED=true
```

Its credentials (account/app/policy ids + the Bearer API token) are **not** env
vars: an admin stores them **encrypted** via **Administration → Policy →
Cloudflare Access** (the `portal_policy` row), or headlessly with the co-located
CLI:

```sh
amnezia-panel cf-config --account=<ACCOUNT_ID> --app=<APP_ID> --policy=<POLICY_ID>
amnezia-panel cf-token <CF_API_TOKEN>     # stored encrypted, write-only
```

(see [`CLI.md`](./CLI.md) — the CLI mints an admin identity from
`PANEL_IDENTITY_SECRET`, so an operator on the panel host configures this without a
browser login). This supersedes running Direction 1 and Direction 2 as two
separate env-driven tasks (which would fight — see the safety note at the end of
Direction 2). The per-direction sections below remain the reference for the
underlying Cloudflare API and the exact token scopes.

Bootstrap admins (`BOOTSTRAP_ADMIN_EMAILS`) are **pinned**: the sync never drops
them from the policy `include` list and never disables them, so the policy can
never empty itself and lock everyone out of the edge.

How it stays consistent — a **3-way merge** against a stored baseline (the email
set last synced), so the two kinds of "active in the panel, absent from
Cloudflare" are told apart:

- **Added in the panel** (active, not in the baseline) → pushed to the Access
  policy; **never** disabled, even before the first push (a freshly-added user is
  protected against a race with the write-back).
- **Removed in Cloudflare** (in the baseline, now gone from the policy) → the
  panel disables that account and revokes its keys — **unless** a surviving
  `email_domain` rule still admits that same address (see "domain cover"
  below), in which case the sync disables nothing and revokes nothing. For a
  domain-covered address, removing it from the Access policy no longer offboards
  anyone: disable the person **in the panel** instead — the address will keep
  being re-added to the policy on every sync interval regardless (see "domain
  cover").
- **Added directly in Cloudflare** (an unknown email) → turned into a panel
  account the moment that person first signs in. Cloudflare already gated
  their identity at the edge, so `resolveIdentity`
  (`apps/control-api/src/postgresRepository.ts`) skips the panel's own
  allowlist check for the `cloudflare-access` login provider and
  auto-provisions the account on that first request; ownership (below) then
  keeps the hand-added rule in the policy indefinitely, so this is not a
  narrow race but the standing trust model — **membership in the Access
  policy is equivalent to being granted a panel account.** Add an address to
  the policy only when you mean for that person to have a panel account.

Safety rails carry over, and three more make the sync unable to destroy what it
did not create:

- an unconfigured token or an empty active-user set is a no-op (never wipes the
  allowlist), and bootstrap admins (`BOOTSTRAP_ADMIN_EMAILS`) are never disabled
  or dropped;
- **ownership** — the panel deletes only the email rules the stored baseline says
  it added. Ownership is claimed by being an active panel user, not by the
  baseline alone: an address put in the policy by hand, or by another tool,
  keeps its rule untouched only for as long as it is not also an active panel
  user. The moment it is, the panel claims that rule — it is dropped from the
  foreign set and re-emitted as a bare `{"email":{"email":...}}`, so any fields
  this client does not model are lost, and the panel owns the address from then
  on. Non-email rules (`email_domain`, groups) are preserved as before.
- **domain cover** — an address the policy still admits through a surviving
  `email_domain` rule, and that no `exclude` rule denies, is never judged
  "removed in Cloudflare". `exclude` is the idiomatic Cloudflare way to carve
  someone back out of a domain rule — by their exact address, or by naming
  that same domain again in an `email_domain` exclude rule (matching is exact,
  not by sub-domain, so this is how the whole domain gets carved back out, not
  a narrower one) — and it is honoured: an excluded address is still disabled
  and its keys still revoked, domain rule or not. (`require` — AND-style
  conditions — is a known gap: it is not evaluated, so a person gated behind a
  `require` rule is treated the same as anyone the `include` rules alone would
  admit.) This rail is a genuine trade, not a free win: it
  removes the *only* Cloudflare-side way to revoke a domain-covered person's
  keys — the same run that spares them from the disable also PUTs their
  "redundant" explicit address straight back into `include`, so removing it
  from the Access policy alone accomplishes nothing. **The panel is now the
  only offboarding path that reaches that person's keys.** Resolving this for
  good needs a panel-managed allowed-domain setting — one where the panel
  itself owns the `email_domain` rule instead of treating every non-email
  rule as untouchable — which is planned but not yet built.
- **blast radius** — a run that would disable more accounts than
  `ACCESS_SYNC_MAX_DISABLES` (default 10), **or** more than half of the active
  panel, stops without acting and writes an `access.sync_aborted` audit event.
  The proportional half exists because the absolute count alone protects
  nothing on a small panel: removing all 5 users of a 5-person panel is
  `5 <= 10` and trips no count-based guard at all. Setting `ACCESS_SYNC_MAX_DISABLES=0`
  disables **both** halves of the cap, not just the absolute one — the
  documented escape hatch for a genuine mass offboarding. While the cap is
  tripped, sync is paused in **both** directions, not just the disable side:
  newly added panel users are not pushed to the Access policy either, so they
  cannot sign in until an operator raises the limit or resolves the anomaly.

The write-back uses **`PUT`** on the app-scoped policy endpoint (see the verb
note under Direction 2).

### Direction 1 — Access → panel (deactivate on removal)

#### How it works

The worker can run a periodic **access reconcile** task
(`apps/worker/src/accessReconcile.ts`, scheduled in `apps/worker/src/main.ts`):

1. An `AccessDirectory` reports the set of emails still allowed to use the panel.
2. `WorkerRepository.reconcileAccess(allowedEmails)` disables every **active,
   non-admin** user whose email is not in that set, moves their keys to
   `revoking`, enqueues `vpn-key.revoke` jobs, and writes a
   `user.access_revoked` audit event (actor: system). Disabled accounts get
   `deactivation_reason = "access_removed"`.

#### Built-in safety rails

- **Empty allowlist = no-op.** If the directory returns zero emails (the usual
  symptom of a failed lookup), nothing is deactivated. The guard exists in both
  the reconciler and the repository.
- **Admins are never auto-disabled.** Losing the last admin would lock the panel,
  so admin accounts that fall out of the allowlist are surfaced in the worker log
  for a human to offboard deliberately.
- **Reversible.** Re-adding the person to the allowlist does not auto-reinstate
  them (keys were revoked), but an admin can reinstate the account from the
  Пользователи tab; the deactivation reason is shown there.

#### Enabling it

All off by default. See `apps/worker/.env.example`.

| Variable | Default | Meaning |
| --- | --- | --- |
| `ACCESS_RECONCILE_ENABLED` | `false` | Master switch for the periodic task. |
| `ACCESS_DIRECTORY` | `allowlist` | `allowlist` or `cloudflare`. |
| `ACCESS_ALLOWLIST` | — | For `allowlist`: comma/space/semicolon-separated emails. |
| `ACCESS_RECONCILE_INTERVAL_MS` | `3600000` | How often to reconcile. |
| `CF_ACCESS_ACCOUNT_ID` | — | For `cloudflare` mode. |
| `CF_API_TOKEN` | — | For `cloudflare` mode. |
| `CF_ACCESS_GROUP_ID` | — | For `cloudflare` mode (group-backed read). |

**Mode 1 — static allowlist (works today).** The worker keeps the panel's active
accounts in sync with an explicit list. Useful when the source of truth is a
small managed list:

```
ACCESS_RECONCILE_ENABLED=true
ACCESS_DIRECTORY=allowlist
ACCESS_ALLOWLIST=alice@company.tld, bob@company.tld
```

**Mode 2 — Cloudflare Access API (extension point).**
`ACCESS_DIRECTORY=cloudflare` selects `createCloudflareDirectory`. It is
intentionally **not implemented**: reading the identities an Access application
allows needs credentials this repo does not carry, and shipping an unverified API
call risks silently deactivating real accounts against bad data. It therefore
throws until wired, and the periodic task fails loudly (no deactivation) rather
than guessing. To complete it, fill in `getAllowedEmails()` so it authenticates
with `CF_API_TOKEN`, reads the members allowed by the app's policy or the Access
group (`CF_ACCESS_ACCOUNT_ID` / `CF_ACCESS_GROUP_ID`, or `<APP_ID>`/`<POLICY_ID>`
via the endpoints in Direction 2), and returns their emails lowercased. **Keep
the empty-result guard:** on any failure return `[]` so the reconciler skips
instead of deactivating everyone.

#### Verifying

With `ACCESS_DIRECTORY=allowlist` set to a list that omits a test user, watch the
worker log for `access-reconcile: disabled N account(s)`, then confirm in the
admin **Журнал** (a `user.access_revoked` event) and on the **Пользователи** tab
(the account shows "Отключён · доступ Cloudflare отозван").

### Direction 2 — panel → Access (add/remove on the allowlist)

**Goal:** when an admin adds a user in the panel, also add that email to the
Access application's Allow policy `include` list, so the person can actually
reach the login; when the admin deletes/deactivates the user, remove their email
again. This keeps the allowlist you built in **A.3** authored from the panel
instead of the Cloudflare dashboard.

The operation is a **read-modify-write** against the Access **policy** (or a
reusable policy / Access group the app Includes).

#### The API token this needs

Create a Cloudflare **API token** (Zero Trust/dashboard → **My Profile → API
Tokens → Create Token → Custom token**), scoped to the specific account:

- **Permission:** **Access: Apps and Policies — Edit** (Edit implies Read; add
  the explicit **Read** if your UI lists them separately).
- **Account Resources:** **Include → your specific account** (`<ACCOUNT_ID>`),
  not "all accounts".
- Optional, only if you also resolve IdP/group IDs from code: **Access:
  Organizations, Identity Providers, and Groups — Read**.

This is a **Bearer API token** presented as
`Authorization: Bearer <token>` to `https://api.cloudflare.com`. It is **not** an
Access **service token** — a service token (two custom request headers,
`CF-Access-Client-Id` + `CF-Access-Client-Secret`) only gets a machine *past* an
Access gate and grants **no** management ability. See
[`HOSTING.md` §6](./HOSTING.md) for the full side-by-side; do not mix them up.

**How the panel stores it.** The token is a management credential, so the panel
will store it **encrypted at rest** and **write-only**: an admin can set or
replace it in admin settings, but it is **never displayed** back (same treatment
as node-agent API keys). The worker decrypts it only in memory to make the sync
calls. Never place the token in a URL, a log line, or a committed `.env`.

#### The endpoints

Base URL for all of these: `https://api.cloudflare.com/client/v4`.

**Application-scoped policy** (the app's own Allow policy — the default for a
single-app allowlist):

| Method | Path | Use |
| --- | --- | --- |
| `GET` | `/accounts/{account_id}/access/apps/{app_id}/policies` | List the app's policies. |
| `GET` | `/accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}` | Read one policy (get current `include`). |
| `PUT` | `/accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}` | Write the modified policy back (send the whole policy). |
| `POST` | `/accounts/{account_id}/access/apps/{app_id}/policies` | Create a policy. |
| `DELETE` | `/accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}` | Delete a policy. |

**Reusable / account-level policy** (if you Include a shared policy instead — one
allowlist reused across apps):

| Method | Path | Use |
| --- | --- | --- |
| `GET` | `/accounts/{account_id}/access/policies` | List reusable policies. |
| `GET` | `/accounts/{account_id}/access/policies/{policy_id}` | Read one reusable policy. |
| `PUT` | `/accounts/{account_id}/access/policies/{policy_id}` | Update a reusable policy. |
| `POST` | `/accounts/{account_id}/access/policies` | Create a reusable policy. |

> Use **`PUT`** on the app-scoped policy endpoint and send the **whole** policy
> object. Empirically, `PATCH` on this endpoint is rejected with `405`
> (`code 10405 "Method not allowed for this authentication scheme"`) under a
> scoped API token — this is what the worker's write-back does (`updatePolicy`
> in `apps/worker/src/cloudflareApi.ts`). A **reusable** policy is likewise
> updated with `PUT` (`/access/policies/{policy_id}`); an app-scoped policy can be
> promoted with
> `PUT /accounts/{account_id}/access/apps/{app_id}/policies/{policy_id}/make_reusable`.
> `{app_id}` = `<APP_ID>`, `{policy_id}` = `<POLICY_ID>`, `{account_id}` =
> `<ACCOUNT_ID>` — all recorded in **A.7**.

#### The JSON shape

The `include` array is the allowlist; each entry is one rule:

- specific address → `{ "email": { "email": "person@gmail.com" } }`
- corporate domain → `{ "email_domain": { "domain": "company.tld" } }`

Adding a user = appending their `{"email":{"email":...}}` object to `include`;
removing = dropping the matching object. Always send back the **whole** policy
(`name`, `decision`, `include`, `exclude`, `require`) — send the modified
`include` together with the fields you read, not a bare fragment.

#### Worked example (add one email, app-scoped policy)

```sh
BASE="https://api.cloudflare.com/client/v4"
POLICY="$BASE/accounts/$CF_ACCESS_ACCOUNT_ID/access/apps/$CF_ACCESS_APP_ID/policies/$CF_ACCESS_POLICY_ID"

# 1) Read the current policy.
curl -s -H "Authorization: Bearer $CF_API_TOKEN" "$POLICY" > policy.json

# 2) Append the new email to include[], preserving name/decision/exclude/require.
jq '.result
    | {name, decision,
       include: (.include + [{"email":{"email":"new.person@gmail.com"}}]),
       exclude, require}' policy.json > body.json

# 3) Write it back (PUT with the whole policy; PATCH is rejected here with 405).
curl -s -X PUT \
  -H "Authorization: Bearer $CF_API_TOKEN" \
  -H "content-type: application/json" \
  --data @body.json "$POLICY"
```

Removing a user is the same read-modify-write with the deletion filter in step 2,
e.g. `include: [.include[] | select(.email.email != "new.person@gmail.com")]`.

#### Env vars

The write-back sync consumes:

| Variable | Meaning |
| --- | --- |
| `CF_API_TOKEN` | The Bearer API token above (stored encrypted, write-only). |
| `CF_ACCESS_ACCOUNT_ID` | `<ACCOUNT_ID>`. |
| `CF_ACCESS_APP_ID` | `<APP_ID>` — the Access application. |
| `CF_ACCESS_POLICY_ID` | `<POLICY_ID>` — the Allow policy to edit. |

(`CF_API_TOKEN` and `CF_ACCESS_ACCOUNT_ID` are shared with Direction 1's
`cloudflare` mode; `CF_ACCESS_APP_ID`/`CF_ACCESS_POLICY_ID` target the policy for
write-back, where Direction 1's read path may instead use `CF_ACCESS_GROUP_ID`.)

#### Safety notes

- **Never PATCH an empty `include`.** A policy with no Include rules is a policy
  that admits everyone or no one depending on decision — mirror Direction 1's
  empty-guard: if the computed `include` would be empty, abort and log instead of
  writing.
- **Never rebuild `include` from the panel's set alone.** The policy may hold
  rules the panel did not write. Compute the next `include` as: every non-email
  rule, plus every email rule that is outside **both** the panel's baseline
  and its desired set (the truly foreign ones), plus the panel's desired set —
  in that order. An address that is hand-added in Cloudflare and also an
  active panel user is outside the baseline but inside the desired set, so it
  must be excluded from the foreign group — otherwise it is emitted twice.
- **Keep the bootstrap admins in the list.** Do not let a panel-side delete
  remove an address that is also in `BOOTSTRAP_ADMIN_EMAILS`, or an admin could
  lock themselves out at the edge.
- **The two directions can fight.** If you run Direction 1 in `cloudflare` mode
  against the same policy Direction 2 writes, make Access the single source of
  truth for that policy and let the panel be the editor — do not also maintain a
  separate `ACCESS_ALLOWLIST` that disagrees with it.

---

## Credential recap

Two Cloudflare credentials show up around Access and are **not**
interchangeable — the management **API token** (Bearer, this doc) versus an
Access **service token** (gets a machine past a gate, no management power). The
full table is in [`HOSTING.md` §6](./HOSTING.md).

## Related documents

- [`docs/HOSTING.md`](./HOSTING.md) — top-level raise: proxy, Google IdP,
  production identity env, credential types.
- [`docs/AGENT-HOST-SETUP.md`](./AGENT-HOST-SETUP.md) — node + control-plane
  install runbook (identity model in Part C).
- [`docs/DEPLOY-UPDATE.md`](./DEPLOY-UPDATE.md) — updating the panel stack and the
  VPN node from git.
