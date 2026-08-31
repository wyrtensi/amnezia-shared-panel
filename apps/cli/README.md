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
| `PANEL_ADMIN_EMAIL` | **dev** — sent as `x-dev-user-email` |
| `CF_ACCESS_CLIENT_ID` + `CF_ACCESS_CLIENT_SECRET` | **prod** — Cloudflare Access service token, to pass the public Access-proxied domain |

The identity must resolve to an **admin** account.

```bash
# dev, straight to the control-api
CONTROL_API_URL=http://127.0.0.1:3001 PANEL_ADMIN_EMAIL=admin@example.com \
  node apps/cli/dist/main.js overview

# prod, through the Cloudflare-proxied panel domain
CONTROL_API_URL=https://vpn.example.com \
CF_ACCESS_CLIENT_ID=…​.access CF_ACCESS_CLIENT_SECRET=cfast_… \
  node apps/cli/dist/main.js users
```

## Commands

Read: `overview`, `users`, `keys`, `nodes`, `audit [--limit=N]`, `quota`,
`policy` — add `--json` for raw JSON.

User management (id **or** email): `user-create <email> [name] [--admin]`,
`user-role <id|email> <admin|user>`, `user-limit <id|email> <n|default>`,
`user-disable <id|email>`, `user-enable <id|email>`,
`quota-approve <req-id> [note]`, `quota-reject <req-id> [note]`.

Keys / nodes / config: `key-revoke <id>`, `key-disable <id>`, `key-enable <id>`,
`node-reconcile <id>`, `policy-set --<field>=<value> …`,
`cf-config --account= --app= --policy=`, `cf-token <token>`.

Run `amnezia-panel help` for the full list and the `policy-set` field reference.
