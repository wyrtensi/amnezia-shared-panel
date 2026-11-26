# Temporary `containerd-shim-runc-v2` Override (`ttrpc#241`)

## Why this exists (and what it does NOT fix)

During runtime memory diagnostics (`agent-changes/2026-11-06-runtime-leak-cause-tests.md`),
reproducible control tests confirmed a map retention leak inside `github.com/containerd/ttrpc`
(`containerd/ttrpc#241` — `fix: add id lock to fix map leak`), where completed ttrpc stream
entries could remain retained in memory when close/send races occurred. Upstream
`containerd/ttrpc#241` remains unmerged and unshipped in official `containerd` / `containerd.io`
packages.

Scope boundaries — keep these honest:
- This temporary override fixes the confirmed `ttrpc#241` stream-map retention race in
  `containerd-shim-runc-v2` while upstream packages still lag.
- It does **not** claim to explain or eliminate the separate pipe-FD accumulation symptom
  observed previously on a wedged host, which has not been reproduced in the lab.
- In addition, `services/node-agent` replaces shell-wrapped `exec("docker ...")` calls with
  direct `execFile("docker", ...)` calls so timeouts terminate the `docker` CLI directly rather
  than leaving orphaned `docker exec` child processes under PID 1.

---

## Branch isolation policy (`main` stays 100% upstream)

`main` **must never** build or ship a custom `containerd` or `ttrpc` dependency.

1. **`main` (`infra/node/shim-override/shim-override.env`):**
   - Ships `SHIM_MODE=upstream` only, with no custom Go build and no bundled shim binaries.
   - Whenever any node updates to a `node-agent` image built from `main`,
     `infra/node/scripts/agent-update.sh` automatically removes our temporary `dpkg-divert`
     (`amnezia-node-shim`) if present and restores the host's stock `/usr/bin/containerd-shim-runc-v2`.

2. **Temporary override branch (`ops/shim-ttrpc-pr241`):**
   - Branched cleanly off the panel release branch and **never merged into `main`**.
   - Contains only the custom shim build stage (`infra/node/shim-override/build-shims.sh` +
     `services/node-agent/Dockerfile`) compiling `containerd-shim-runc-v2` from pinned upstream
     `containerd` release tags (`1.7`, `2.2`, `2.3`, `2.4`) with `github.com/containerd/ttrpc`
     replaced at pinned PR `#241` commit `3645259866b6106bf4a9f7112a7055047a816ae8`.

---

## How `agent-update.sh` delivers and protects hosts

When updating `node-agent` sequentially via the panel UI or CLI
(`amnezia-panel node-agent-update <node-id> --image=<repo@sha256:...> --confirm`):

1. `agent-update.sh` pulls the digest-pinned `node-agent` image and extracts
   `/opt/node-agent/bin/shim-override.env`.
2. If `SHIM_MODE=override`:
   - Reads the host's `containerd --version` minor line (`1.7`, `2.2`, `2.3`, or `2.4`).
   - Extracts `/opt/node-agent/bin/shims/containerd-shim-runc-v2-<minor>`, verifies its SHA-256
     against `SHIM_SHA256_<major>_<minor>`, and runs `containerd-shim-runc-v2 -v`.
   - If the host's `containerd` minor line does not match a shipped binary, `dpkg-divert` is
     missing, or verification fails, it **fail-safely skips** the shim step with a warning and
     still completes the `node-agent` update without breaking the host.
   - Atomically installs the binary to `/usr/local/lib/amnezia/containerd-shim-runc-v2` (`0755`),
     diverts `/usr/bin/containerd-shim-runc-v2` -> `/usr/bin/containerd-shim-runc-v2.upstream` under
     `--package amnezia-node-shim`, symlinks `/usr/bin/containerd-shim-runc-v2`, and writes
     `/usr/local/lib/amnezia/shim-override.meta`.
   - Recreates **only** `amnezia-node-agent` (`--no-deps`), so the new agent immediately exercises
     the overridden shim. If `amnezia-node-agent` fails its health gate, `rollback()` removes the
     diversion, restores the stock shim binary, and rolls back `node-agent`.
3. If `SHIM_MODE=upstream` (every image built from `main`):
   - Automatically removes any `amnezia-node-shim` diversion and deletes
     `/usr/local/lib/amnezia/containerd-shim-runc-v2`, returning the host to its apt-managed
     `/usr/bin/containerd-shim-runc-v2` (and restores the prior override on `rollback()` if the new
     agent fails its health check).

### Important operational caveat for AWG containers

`agent-update.sh` runs `docker compose up --detach --no-deps --no-build node-agent`, so live
`amnezia-awg3` / `amnezia-awg2` / `amnezia-awg` containers are **never restarted** during an
agent update. They continue running under the shim process that originally started them until an
explicit maintenance recreate/restart of those containers (when scheduled with zero-downtime notice).

---

## Building and rolling out from `ops/shim-ttrpc-pr241`

1. Trigger **Release node-agent image** (`workflow_dispatch`) on branch `ops/shim-ttrpc-pr241` to
   publish an immutable `@sha256:...` image in GHCR (do not tag a release off this branch).
2. Roll out one node at a time:
   ```sh
   amnezia-panel node-agent-update <node-id> --image=ghcr.io/<owner>/<repo>/node-agent@sha256:<digest>
   amnezia-panel node-agent-update <node-id> --image=ghcr.io/<owner>/<repo>/node-agent@sha256:<digest> --confirm
   ```
3. Verify on the host:
   ```sh
   dpkg-divert --list '*containerd-shim*'
   readlink -f /usr/bin/containerd-shim-runc-v2
   /usr/bin/containerd-shim-runc-v2 -v
   cat /usr/local/lib/amnezia/shim-override.meta
   ```

---

## Exit criteria & returning cleanly to upstream

Return to stock upstream `containerd` as soon as **all** of the following hold:
1. `containerd/ttrpc#241` (or equivalent fix) is merged upstream and released in a `ttrpc` tag.
2. Downstream `containerd` / Docker `containerd.io` packages including that fix are available via
   `apt` for the fleet's hosts.

Return procedure:
1. Upgrade host `containerd` / `containerd.io` packages during a planned node maintenance window.
2. Delete the temporary `ops/shim-ttrpc-pr241` branch (never merge it into `main`).
3. Release `node-agent` normally from `main` (which ships `SHIM_MODE=upstream`). Updating each node
   automatically cleans up `amnezia-node-shim` and leaves zero custom binary residue on the host.

### Manual emergency rollback on a single host

```sh
sudo rm -f /usr/bin/containerd-shim-runc-v2
sudo dpkg-divert --package amnezia-node-shim --remove --rename /usr/bin/containerd-shim-runc-v2
sudo rm -f /usr/local/lib/amnezia/containerd-shim-runc-v2 /usr/local/lib/amnezia/shim-override.meta
sudo rmdir /usr/local/lib/amnezia 2>/dev/null || true
/usr/bin/containerd-shim-runc-v2 -v
```
