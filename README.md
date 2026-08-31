<div align="center">

<img src="docs/assets/logo.svg" alt="Shared Panel" width="360">

**A self-hosted control plane for AmneziaWG VPN access.**
Employees create and manage their own device keys; admins manage users, nodes,
policy, and telemetry across one or more nodes — behind a login you control.

[![CI](https://github.com/wyrtensi/amnezia-shared-panel/actions/workflows/ci.yml/badge.svg)](https://github.com/wyrtensi/amnezia-shared-panel/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/tag/wyrtensi/amnezia-shared-panel?sort=semver&label=release&color=cc7328)](https://github.com/wyrtensi/amnezia-shared-panel/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-cc7328)](LICENSE)
[![AmneziaWG 3.1](https://img.shields.io/badge/AmneziaWG-3.1-17917d)](#protocol)
[![Next.js](https://img.shields.io/badge/Next.js-000?logo=nextdotjs&logoColor=white)](https://nextjs.org)

</div>

## Protocol

**This project targets AmneziaWG 3.1 as its primary protocol.** New nodes and new
keys should use AWG 3.1 (header protection, ranged headers, random trailers).
AmneziaWG 2.0 is retained only for backward compatibility with already-deployed
nodes and existing peers during the transition; do not build new features against
2.0. AWG 3.1 keys require the official AmneziaVPN client 5.0.1.5 or newer.

## Two ways users sign in

The panel is usable even where a working VPN or Cloudflare is unavailable — it
accepts either identity, side by side:

- **Cloudflare Access** — the edge injects a signed JWT the control-api verifies
  (Google Workspace as the IdP, an email/group allowlist at the edge).
- **Direct server-side Google** — for users who cannot reach Cloudflare, the panel
  serves itself on a DNS-only host with its **own** Google login and a signed
  session. See [`docs/INSTALL.md` §3.5](docs/INSTALL.md).

Roles live in the panel (`admin` / `user`); an admin is also a user (own keys and
quota) and is pinned so it can never lock itself out.

## Workspace

- `apps/web` — employee and administrator web interface (Next.js).
- `apps/control-api` — authenticated central REST API (Fastify).
- `apps/worker` — provisioning, telemetry, retention, and routing jobs.
- `apps/cli` — admin CLI over the control-api ([`apps/cli/README.md`](apps/cli/README.md)).
- `packages/contracts` — shared public types and validation schemas.
- `packages/db` — PostgreSQL schema, migrations, and repositories.
- `services/node-agent` — reviewed fork of `kyoresuas/amnezia-api`; the HTTP agent
  that fronts an AmneziaWG container on each node.
- `infra/dev` — local Docker Compose environment.
- `infra/prod` — production Compose stack (tiny-host, pulls the image from GHCR).
- `infra/node` — VPN-node deployment assets.

Sensitive local material belongs in the git-ignored `secrets/` directory.

## Quick start (local dev)

```bash
pnpm install
cd infra/dev && docker compose --env-file .env up --build
```

The app comes up at `http://127.0.0.1:3000`. The dev stack sets a dev identity
(`DEV_USER_EMAIL`, default `admin@example.com`) so you sign in without Cloudflare
or Google. To run the services in watch mode without containers: `pnpm dev`.

Before pushing, run what CI runs: `pnpm lint && pnpm typecheck && pnpm build &&
pnpm test`. Full command reference: **[`docs/CLI.md`](docs/CLI.md)**.

## Deploy & update (production)

The live host runs `infra/prod` and **pulls** the published image
`ghcr.io/<owner>/amnezia-shared-panel:latest`. Cutting a release = tag the public
repo `vX.Y.Z`; CI builds and pushes the image (the tag is stamped into
`GET /api/admin/version`). On the host, `bash infra/prod/update.sh` performs a
data-safe update (backup DB → pull → migrate → recreate; volumes untouched), and
the **Administration → Overview → Update** button does the same via a host systemd
worker after a one-time `sudo bash infra/prod/install-updater.sh`.

## Documentation

- **[`docs/INSTALL.md`](docs/INSTALL.md) — start here.** Agent-driven install
  runbook: the inputs to collect, then node + panel + public access (Cloudflare
  Access with Google Workspace, and the optional direct Google login), the
  temporary→least-privilege API-token hand-off, and the admin/user policy split.
- [`docs/CLI.md`](docs/CLI.md) — every command for the panel **and** a node
  (dev, build, database, deploy/update, backup, admin CLI; AmneziaWG/awg, Docker,
  node-agent, health).
- [`docs/HOSTING.md`](docs/HOSTING.md) — architecture, identity model, credential
  types, secrets, end-to-end hosting.
- [`docs/AGENT-HOST-SETUP.md`](docs/AGENT-HOST-SETUP.md) — install a fresh AWG host
  and wire it to the panel.
- [`docs/NODE-CONNECT.md`](docs/NODE-CONNECT.md) — register and reach a live node
  (SSH tunnel or direct TLS) and its safety constraints.
- [`docs/CLOUDFLARE-SETUP.md`](docs/CLOUDFLARE-SETUP.md) / [`docs/CLOUDFLARE-ACCESS.md`](docs/CLOUDFLARE-ACCESS.md)
  — the tunnel + Google login, and the Access app / allowlist / two-way sync.
- [`docs/DEPLOY-UPDATE.md`](docs/DEPLOY-UPDATE.md) · [`docs/UPDATE-MECHANISM.md`](docs/UPDATE-MECHANISM.md)
  — updating the stack from git, and the in-panel Update button internals.

## License

Released under the MIT License — see [`LICENSE`](LICENSE).

`services/node-agent` is a fork of
[`kyoresuas/amnezia-api`](https://github.com/kyoresuas/amnezia-api) (MIT), and the
project builds on the AmneziaWG / Amnezia VPN ecosystem. Third-party attributions
and the licenses of notable dependencies are listed in [`NOTICE.md`](NOTICE.md).
