# @amnezia/cli

Admin CLI for the control plane — a thin, dependency-free HTTP client over the
control-api's admin endpoints, so the panel can be driven from a shell, cron, or
another host in addition to the web UI.

## Build & run

```bash
pnpm --filter @amnezia/cli build
node apps/cli/dist/main.js <command>
# or, without building:
pnpm --filter @amnezia/cli dev -- <command>
```

## Auth & config

Identity is resolved exactly like the API does it:

| Env | Purpose |
| --- | --- |
| `CONTROL_API_URL` | API base (default `http://127.0.0.1:3001`) |
| `PANEL_IDENTITY_SECRET` (+ `CLI_ADMIN_EMAIL` or `BOOTSTRAP_ADMIN_EMAILS`) | **prod, co-located** — mints the same `x-panel-identity` token the web issues after a Google login |
| `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` | **prod, remote** — Cloudflare Access service token, to pass the public Access-proxied domain |
| `PANEL_ADMIN_EMAIL` | **dev** — sent as `x-dev-user-email` (rejected by a production API) |

Resolved in that order (`identity.ts`); the identity must resolve to an
**admin** account.

The co-located path is the one to reach for on a production host: whoever can
run the CLI there already holds `PANEL_IDENTITY_SECRET`, so no Cloudflare token
is needed. The prod image ships the CLI, and the `control-api` service already
has both variables in its environment — so the shortest route on a deployed
panel is to run it inside that container:

```bash
# prod, on the panel host — no browser, no CF token
docker compose exec -T -e CONTROL_API_URL=http://127.0.0.1:3001 control-api \
  node /app/apps/cli/dist/main.js nodes

# prod, from elsewhere, through the Cloudflare-proxied panel domain
CONTROL_API_URL=https://vpn.example.com \
CF_ACCESS_CLIENT_ID=…​.access CF_ACCESS_CLIENT_SECRET=cfast_… \
  node apps/cli/dist/main.js users

# dev, straight to the control-api
CONTROL_API_URL=http://127.0.0.1:3001 PANEL_ADMIN_EMAIL=admin@example.com \
  node apps/cli/dist/main.js overview
```

## Commands

`help` is the authoritative reference — it carries every flag, and the
`policy-set` / `node-add` field lists. The map below is for finding the right
command name:

**Read** (add `--json` for raw JSON): `overview`, `users`, `keys`, `stale-keys`,
`nodes`, `node-metrics`, `audit [--limit=N]`, `quota [--all]`, `policy`,
`periods`, `global-routes`, `rules`, `checks`, `check-results`, `probe`,
`probe-results`, `bridges`, `bridge-routes`, `bridge-rollback-preflight`,
`client-releases`, `version`, `traffic [--days=N]`.

**Users** (accept a user id **or** email): `user-create`, `user-role`,
`user-limit`, `user-disable`, `user-enable`, `user-delete`, `user-nodes`,
`user-bridge`, `user-routes`, `user-notices-reset`, `user-create-key`,
`offboarded-purge`, `quota-approve`, `quota-reject`.

**Nodes:** `node-add`, `node-update`, `node-remove` (`--with-keys --confirm=`
to delete a node and every key issued on it), `node-reconcile`,
`node-capacity`, `node-ipv6-stub`, `node-agent-update`, `node-agent-log`,
`node-checks`, `node-probe`.

**Keys & split-tunnel rules:** `key-config`, `key-rename`, `key-internal-name`,
`key-revoke`, `key-disable`, `key-enable`, `key-purge`, `keys-purge-revoked`,
`stale-keys-revoke`, `global-routes-set`, `rules-activate`, `rules-follow`.

**Bridges (AWG 3.1):** `bridges`, `bridge-add`, `bridge-enroll`,
`bridge-agent-update`, `bridge-agent-log`, `bridge-rollback-preflight`,
`bridge-delete`, `bridge-routes`, `bridge-route-prepare`, `bridge-route-verify`,
`bridge-route-activate`, `bridge-route-direct`, `bridge-route-release`,
`bridge-route-test-config`, `bridge-tls-gate`.

**Checks, probe, policy & Cloudflare:** `check-create`, `check-set`,
`check-delete`, `check-run`, `check-reset`, `probe-set`, `probe-delete`,
`probe-run`, `policy-set`, `cf-config`, `cf-token`, `cf-sync`, `cf-domains`,
`panel-update`.

For every flag and error code see [`docs/CLI.md`](../../docs/CLI.md).

**Reachability:** `probe-results --bridges --json` lists bridge results, and
`bridge-probe <bridge-id> --on|--off` controls bridge alerts. See the
[reachability runbook](../../docs/REACHABILITY-PROBE.md).

### Registering a node

```bash
node apps/cli/dist/main.js node-add \
  --name=<panel name> --api-url=http://host.docker.internal:<tunnel port> \
  --api-key-file=<path to the node's secrets/node-agent-api-key> \
  --protocol=awg3 --max-peers=500 --enabled-protocols=awg3
```

It answers `node added: <name> (<uuid>)`; feed that uuid to `node-reconcile` to
poll the node immediately instead of waiting for the 60 s telemetry cycle.

`scripts/add-node.sh` does this — and the whole host rollout around it — in one
command; see [`docs/NODE-CONNECT.md`](../../docs/NODE-CONNECT.md).
