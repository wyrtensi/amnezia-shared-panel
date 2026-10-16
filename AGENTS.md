# Amnezia Panel agent instructions

## Before making changes

- Treat `D:\amnezia-panel` as the canonical project root.
- Read the newest relevant document in `plans/` and the newest handoff in `agent-changes/`.
- Keep plans in `plans/` and concise implementation handoffs in `agent-changes/`.

## Security

- Secrets belong only in `secrets/`. Never commit, log, quote, or copy their values into plans or handoffs.
- Do not copy private SSH keys into this repository. Refer to their local absolute path from `secrets/.secrets`.
- Redact VPN configs, QR payloads, private keys, API keys, passwords, and backups from command output and application logs.
- Do not use monkey-patching. If a supported implementation path is unavailable, stop and report the blocker.

## Code and Git

- Write code comments only in English.
- Work on a feature branch, not `main` or `master`.
- Run relevant tests, lint, type checks, and builds before claiming completion or committing.
- Commit and push using the configured user identity. Do not add `[codex]` to commit or PR titles.
- Preserve unrelated user changes and never use destructive Git resets or checkouts.

## Architecture and API

- The control plane is strictly API-first. Every user capability, administrative action, node operation, policy setting, and configuration export must be fully supported and manageable via typed REST API endpoints in `@amnezia/control-api`.
- The web frontend (`apps/web`) is a decoupled presentation client that consumes the Control API. No backend business logic or state mutations may bypass the Control API.
- Any new feature must first be designed and implemented with typed request/response contracts, authorization checks, transaction safety, and audit logging in `@amnezia/control-api` before exposing UI controls.

## Protocol

- This project targets **AmneziaWG 3.1** as its primary protocol. New nodes and
  new keys must default to AWG 3.1; build new protocol features against 3.1 only.
- AmneziaWG 2.0 (`awg2`) is retained solely for backward compatibility with
  already-deployed nodes and existing peers during the transition. Do not remove
  the awg2 code paths (existing peers, including the operator's own connection on
  the current node, depend on them), but do not add new 2.0-only capabilities.
- AWG 3.1 configs require the official AmneziaVPN client 5.0.1.5 or newer.

## Server and Node Management

- When setting up, registering, or configuring a new VPN server/node, ALWAYS ask the user for the desired node display name (e.g. asking how the node should be named in the panel, such as "Hetzner DE", "Amsterdam Primary", etc.) rather than assuming or hardcoding a name.
- Roll a new node out with `scripts/add-node.sh --host <ip> --name <name>` (config in the git-ignored `scripts/add-node.env`; `--dry-run` first). It is idempotent and encodes the traps that break a hand-rolled rollout — see [`docs/NODE-CONNECT.md`](docs/NODE-CONNECT.md).
- A rollout step exiting 0 is not evidence it did anything. Confirm the node actually appears in the admin CLI's `nodes` output before reporting success.

## Documentation

- Maintain only necessary and actionable documentation (e.g., operational runbooks, architecture docs, deployment checklists, and READMEs).
- Keep documentation in sync whenever code, scripts, configurations, or operational procedures change.
- Never include secret values, private keys, or passwords in documentation.

## Handoffs

- After each substantial iteration, create `agent-changes/YYYY-MM-DD-<slug>.md`.
- Keep the handoff short: outcome, important decisions, verification performed, remaining risks, and relative links to the main changed files.
- Never include secret values in a handoff.

