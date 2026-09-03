# Production AWG2 + AWG3 node

This directory contains local, operator-run deployment assets for one Linux/amd64 VPN node. The scripts do not use SSH and do not mutate remote hosts. The node runs AmneziaWG 2.0 and AmneziaWG 3.1 side by side in separate containers so clients can be issued keys for either protocol.

**AmneziaWG 3.1 is the primary protocol** for new keys and new nodes. AmneziaWG 2.0 is kept only for backward compatibility with existing peers on already-deployed nodes; a brand-new node can run AWG 3.1 alone.

## Fixed deployment contract

- AWG2 image: `amneziavpn/amneziawg-go:0.2.19`.
- Approved AWG2 Linux/amd64 manifest digest: `sha256:3c78eb57ef5cb44f63aed185e79c104593c854a5ebde3e1075470301bcc77c44`.
- Verified AWG2 multi-platform index digest: `sha256:acef5ae84808a9568448e9d8c7a96f640a5ccc590b0f8dfbc2df9f9dc0e848c9`.
- AWG3 image: `amneziavpn/amneziawg-go:3.1.20260814`.
- Approved AWG3 multi-platform index digest: `sha256:4450928744b051589bb3ba5cf6dd0cd8d7dc470b9432dc32d03d5ff5ede11b7a`.
- VPN endpoints: UDP `51889` (AWG2), UDP `51890` (AWG3).
- VPN subnets: `10.89.0.0/22` (AWG2, server `10.89.0.1/22`); `10.90.0.0/22` (AWG3, server `10.90.0.1/22`).
- Node-agent endpoint: host loopback `127.0.0.1:4001` only, `PROTOCOLS_ENABLED=amneziawg2,amneziawg3`.
- Persistent state: `state/amnezia-awg2` and `state/amnezia-awg3` (`awg0.conf`, key material, and `clientsTable`).
- Restart policy: `unless-stopped`; Watchtower and mutable `latest` tags are forbidden.

Both AWG images are minimal toolkits whose default command is `/bin/sh`. `scripts/awg2-entrypoint.sh` and `scripts/awg3-entrypoint.sh` supply the missing service lifecycle, initialize state only when the entire state set is absent, and refuse partial state. They use the userspace implementation, so each container receives only `NET_ADMIN` and `/dev/net/tun`; neither receives `SYS_MODULE` or full privileged mode. The AWG3 entrypoint additionally generates a `HeaderProtectionKey` and enables `RandomTrailers`, and refuses to start if the header-protection key is missing.

The active `I1` value is deliberately identical on server and generated clients. Leaving it absent on the server while the current node-agent supplies it to clients prevents a successful handshake.

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

## State and recovery

`backup.sh` stops the node-agent, AWG2, and AWG3 briefly so each `awg0.conf` and `clientsTable` cannot be captured across a mutation. It creates a mode-`0600` archive plus a SHA-256 sidecar in `backups/` covering `state/amnezia-awg2` and (once initialized) `state/amnezia-awg3`, then restarts only services that were previously running. The archive contains VPN private material; copy it only to approved encrypted backup storage.

`rollback.sh` accepts one explicit archive path. It rejects absolute/traversal archive members and links, validates the AWG2 config and `clientsTable` (and the AWG3 state when the archive contains it), takes a safety backup, restores with strict permissions, and requires all health checks. If restored state fails health verification, it puts the pre-rollback state back.

## Security boundary

The node-agent needs the Docker socket to execute the approved AWG2 and AWG3 tooling. Treat compromise of the node-agent as host-level compromise. TCP 4001 is intentionally not published on any non-loopback address; use only an approved private transport from the control plane. Do not open 4001 in the host firewall.
