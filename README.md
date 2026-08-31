# Amnezia Panel

Self-service AmneziaWG control plane for employee device keys, administrator management, telemetry, and multi-node operation.

## Protocol

**This project targets AmneziaWG 3.1 as its primary protocol.** New nodes and new
keys should use AWG 3.1 (header protection, ranged headers, random trailers).
AmneziaWG 2.0 is retained only for backward compatibility with already-deployed
nodes and existing peers during the transition; do not build new features against
2.0. AWG 3.1 keys require the official AmneziaVPN client 5.0.1.5 or newer.

## Workspace

- `apps/web` — employee and administrator web interface.
- `apps/control-api` — authenticated central REST API.
- `apps/worker` — provisioning, telemetry, retention, and routing jobs.
- `apps/cli` — admin CLI over the control-api ([`apps/cli/README.md`](apps/cli/README.md)).
- `packages/contracts` — shared public types and validation schemas.
- `packages/db` — PostgreSQL schema, migrations, and repositories.
- `services/node-agent` — reviewed fork of `kyoresuas/amnezia-api` v1.0.0.
- `infra/dev` — local Docker Compose environment.
- `infra/node` — VPN-node deployment assets.

Sensitive local material belongs in the ignored `secrets/` directory.

## Documentation

- **[`docs/INSTALL.md`](docs/INSTALL.md) — start here.** Agent-driven install
  runbook: the inputs to collect, then node + panel + Cloudflare Access with Google
  Workspace login, the temporary→least-privilege API-token hand-off, and the
  admin/user policy split. Links to the detailed docs below.
- [`docs/HOSTING.md`](docs/HOSTING.md) — top-level end-to-end guide: raise the VPN
  node, the control-plane panel, and public hosting via Cloudflare + Access.
- [`docs/AGENT-HOST-SETUP.md`](docs/AGENT-HOST-SETUP.md) — end-to-end guide for an
  agent or operator installing a fresh AWG host and wiring it to the panel.
- [`docs/NODE-CONNECT.md`](docs/NODE-CONNECT.md) — connect a live VPN node to the
  panel (SSH tunnel or direct TLS), registration, and safety constraints.
- [`docs/CLOUDFLARE-ACCESS.md`](docs/CLOUDFLARE-ACCESS.md) — create the Access
  application (Google IdP + email allowlist) and the two-way panel ↔ allowlist
  sync (the required API token and endpoints).
- [`docs/DEPLOY-UPDATE.md`](docs/DEPLOY-UPDATE.md) — update the control-plane stack
  from git (rebuild image, run migrations, recreate containers) and roll back.

## License

This project is released under the MIT License — see [`LICENSE`](LICENSE).

`services/node-agent` is a fork of
[`kyoresuas/amnezia-api`](https://github.com/kyoresuas/amnezia-api) (MIT), and the
project builds on the AmneziaWG / Amnezia VPN ecosystem. Third-party attributions
and the licenses of notable dependencies are listed in [`NOTICE.md`](NOTICE.md).
