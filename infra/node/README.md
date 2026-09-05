# Production AWG2 + AWG3 node

This directory contains local, operator-run deployment assets for one Linux/amd64 VPN node. The scripts do not use SSH and do not mutate remote hosts.

**A node serves AmneziaWG 3.1 only by default.** AmneziaWG 2.0 is opt-in: it lives behind the `awg2` compose profile and is started only when `PROTOCOLS_ENABLED` names `amneziawg2`, which is the same value the agent uses to decide what it manages. Keep it enabled on a node that still carries legacy peers; leave it off everywhere else. `node-agent` no longer depends on awg2, so a 3.1-only node starts without it — previously the agent refused to come up until somebody brought up a protocol the node does not serve.

`preflight.sh` refuses to deploy when `amnezia-awg2` is running but `PROTOCOLS_ENABLED` does not name it, so an upgrade cannot silently stop a container that is carrying peers.

## Fixed deployment contract

- AWG2 image: `amneziavpn/amneziawg-go:0.2.19`.
- Approved AWG2 Linux/amd64 manifest digest: `sha256:3c78eb57ef5cb44f63aed185e79c104593c854a5ebde3e1075470301bcc77c44`.
- Verified AWG2 multi-platform index digest: `sha256:acef5ae84808a9568448e9d8c7a96f640a5ccc590b0f8dfbc2df9f9dc0e848c9`.
- AWG3 image: `amneziavpn/amneziawg-go:3.1.20260828`.
- Approved AWG3 multi-platform index digest: `sha256:cbafc02b8373a83f428272db6d8001b37bc02e6211cbd8c0cb4e2e3759b12b72`.
- VPN endpoints: UDP `51889` (AWG2), UDP `51890` (AWG3).
- VPN subnets: `10.89.0.0/22` (AWG2, server `10.89.0.1/22`); `10.90.0.0/22` (AWG3, server `10.90.0.1/22`).
- Node-agent endpoint: host loopback `127.0.0.1:4001` only. `PROTOCOLS_ENABLED` defaults to `amneziawg3`; add `amneziawg2` to it on a node that still carries legacy peers, which is also what activates the `awg2` compose profile.
- Persistent state: `state/amnezia-awg2` and `state/amnezia-awg3` (`awg0.conf`, key material, and `clientsTable`).
- Restart policy: `unless-stopped`; Watchtower and mutable `latest` tags are forbidden.

Both AWG images are minimal toolkits whose default command is `/bin/sh`. `scripts/awg2-entrypoint.sh` and `scripts/awg3-entrypoint.sh` supply the missing service lifecycle, initialize state only when the entire state set is absent, and refuse partial state. They use the userspace implementation, so each container receives only `NET_ADMIN` and `/dev/net/tun`; neither receives `SYS_MODULE` or full privileged mode. The AWG3 entrypoint additionally generates a `HeaderProtectionKey` and enables `RandomTrailers`, and refuses to start if the header-protection key is missing.

The AWG3 obfuscation geometry is drawn **per node** by `scripts/awg3-geometry.sh` at first initialization, and never again — rerolling it would invalidate every key already issued from that node. Only `H1`–`H4` and the header-protection key used to vary; `Jc`, `Jmin`, `Jmax`, `S1`–`S4` and the junk packet were constants shared by every node we deploy, so a classifier that learned one node had learned the fleet.

The generator enforces what the protocol enforces (`S1..S4 >= 12` whenever a header-protection key is set; `H1`–`H4` distinct and clear of the WireGuard message types 0–4) and, more importantly, the one rule the protocol does **not** check: `Jmin < Jmax`. `amneziawg-go` computes each junk packet as `min + fastrandn(max - min)` on `uint32`, so an inverted range wraps to a multi-gigabyte allocation per junk packet per handshake. Nothing downstream would catch it.

`I1` is generated per node too. Contrary to an earlier note here, it does **not** have to match between server and client: in `amneziawg-go` the I-packets appear only on the send path (`device.ipackets` is read in `send.go` and in the uapi get/set, never in `receive.go`), so a mismatch cannot break a handshake. `services/node-agent` still carries a stock `I1` in `AppContract.AmneziaWG3.PARAM_DEFAULTS` as a fallback for configs that lack one; that constant is the old fleet-wide fingerprint and should be dropped once every node carries its own.

## Image pin verification

The digest was obtained and checked directly through the OCI registry metadata:

```sh
docker buildx imagetools inspect amneziavpn/amneziawg-go:0.2.19
docker pull --platform linux/amd64 \
  amneziavpn/amneziawg-go@sha256:3c78eb57ef5cb44f63aed185e79c104593c854a5ebde3e1075470301bcc77c44
docker image inspect \
  amneziavpn/amneziawg-go@sha256:3c78eb57ef5cb44f63aed185e79c104593c854a5ebde3e1075470301bcc77c44 \
  --format '{{.Os}}/{{.Architecture}} {{range .RepoDigests}}{{println .}}{{end}}'
```

Expected platform is `linux/amd64` and the repository digest is `amneziavpn/amneziawg-go@sha256:3c78...77c44`.

The node-agent Dockerfile also pins its Node 22 and Docker CLI Linux/amd64 base manifests. Build it locally with `scripts/build-node-agent.sh`, then copy the printed immutable `sha256:...` image ID into `.env`. A published `repository@sha256:digest` reference is accepted as well. Deployment never builds an image implicitly.

## Local preparation

Run these commands on the target Linux/amd64 host from this directory:

```sh
install -m 600 .env.example .env
install -d -m 700 secrets state/amnezia-awg2 state/amnezia-awg3 backups
(umask 077; openssl rand -base64 48 > secrets/node-agent-api-key)
chown root:root secrets/node-agent-api-key
chmod 640 secrets/node-agent-api-key
chmod 700 scripts/*.sh
sh scripts/build-node-agent.sh
```

Edit `.env`, including the immutable image ID, the node's public IPv4 address (the recommended `SERVER_PUBLIC_HOST`; a DNS name is accepted with a preflight `NOTE:`), unique server UUID, and the exact Docker socket group from `stat -c '%g' /var/run/docker.sock`. Never put the API key in `.env` or pass it on a command line.

Then follow [CHECKLIST.md](CHECKLIST.md). `preflight.sh` is non-deploying: it checks Linux/amd64, Docker, TUN, immutable image references, strict permissions, fixed Compose configuration, port conflicts, 2 GiB free disk (3 GiB recommended), and available RAM scaled to `SERVER_MAX_PEERS`
(`358400 KiB * peers / 500`, floored at 192 MiB).

## Updating the agent from the panel (opt-in)

The node-agent container mounts only the Docker socket, so it cannot read this
compose file, cannot write `.env`, and has no compose binary — it cannot durably
replace itself. `scripts/agent-update.sh` does the swap from the host instead, a
port of the panel's own `infra/prod/panel-updater.sh`: the agent drops a request
into a spool, `systemd/amnezia-node-agent-update.path` notices it, and the script
pulls the requested digest, rewrites `NODE_AGENT_IMAGE` in `.env` and recreates
**only** the agent (`--no-deps`), so no tunnel drops. A new agent that fails its
health gate is rolled back to the previous digest.

The feature is off until a host is deliberately wired for it:

```sh
sudo NODE_AGENT_UPDATE_REPO=ghcr.io/<owner>/<repo>/node-agent \
  bash scripts/install-agent-updater.sh
```

Only a digest inside that repository is ever accepted — a tag is mutable, so what
the admin confirmed would not be what the node installs.

Published images also carry the `compose.yaml` they expect at
`/opt/node-agent/deploy/`. That is how the updater tells a node's untouched
compose file (safe to move forward) from one edited on purpose here (stop, and
report the diff for a human to reconcile).

## State and recovery

`backup.sh` stops the node-agent, AWG2, and AWG3 briefly so each `awg0.conf` and `clientsTable` cannot be captured across a mutation. It creates a mode-`0600` archive plus a SHA-256 sidecar in `backups/` covering `state/amnezia-awg2` and (once initialized) `state/amnezia-awg3`, then restarts only services that were previously running. The archive contains VPN private material; copy it only to approved encrypted backup storage.

`rollback.sh` accepts one explicit archive path. It rejects absolute/traversal archive members and links, validates the AWG2 config and `clientsTable` (and the AWG3 state when the archive contains it), takes a safety backup, restores with strict permissions, and requires all health checks. If restored state fails health verification, it puts the pre-rollback state back.

## Security boundary

The node-agent needs the Docker socket to execute the approved AWG2 and AWG3 tooling. Treat compromise of the node-agent as host-level compromise. TCP 4001 is intentionally not published on any non-loopback address; use only an approved private transport from the control plane. Do not open 4001 in the host firewall.
