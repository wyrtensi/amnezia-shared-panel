# Temporary `containerd-shim-runc-v2` Override (`wyrtensi/ttrpc` Fork)

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
- Alongside this shim override, `services/node-agent` replaces shell-wrapped `exec("docker ...")`
  calls with direct `execFile("docker", ...)` calls so timeouts terminate the `docker` CLI
  directly rather than leaving orphaned `docker exec` child processes under PID 1.

---

## Controlled fork & single-switch design

To keep builds reproducible without depending on an unmerged external PR ref, the 12-line
`ttrpc#241` fix is pinned in our own fork instead of pointing directly at a contributor PR:

- **Fork repository:** `https://github.com/wyrtensi/ttrpc`
- **Branch:** `fix/pr241-id-lock` (`v1.2.10` + upstream `containerd/ttrpc#241`)
- **Pinned tag / commit:** `v1.2.10-amnezia.1` (`3645259866b6106bf4a9f7112a7055047a816ae8`)

All toggle state lives in one tracked file: [`infra/node/shim-override/shim-override.env`](../infra/node/shim-override/shim-override.env).

1. **While `SHIM_OVERRIDE_MODE=override`:**
   - `services/node-agent/Dockerfile` runs `infra/node/shim-override/build-shims.sh`, which clones
     `wyrtensi/ttrpc` at `3645259866b6106bf4a9f7112a7055047a816ae8`, builds static
     `containerd-shim-runc-v2` binaries for each supported host `containerd` minor line
     (`1.7`, `2.2`, `2.3`, `2.4`), verifies `go version -m` contains the `/src/ttrpc`
     replacement, and writes their SHA-256 digests into `/opt/node-agent/bin/shim-override.env`.
2. **When switched to `SHIM_OVERRIDE_MODE=upstream`:**
   - `build-shims.sh` skips cloning and Go compilation and emits only `SHIM_MODE=upstream`.
   - On the next `node-agent` update, `infra/node/scripts/agent-update.sh` automatically removes
     the temporary `amnezia-node-shim` `dpkg-divert` diversion and restores stock
     `/usr/bin/containerd-shim-runc-v2`.
3. **Manual one-off override in CI:**
   - `.github/workflows/release-node-agent.yml` (`workflow_dispatch`) accepts `shim_override_mode`
     (`default` / `override` / `upstream`) to build a test or upstream-revert image without even
     editing `shim-override.env`.

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
3. If `SHIM_MODE=upstream`:
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

## Verifying on a host after update

```sh
dpkg-divert --list '*containerd-shim*'
readlink -f /usr/bin/containerd-shim-runc-v2
/usr/bin/containerd-shim-runc-v2 -v
cat /usr/local/lib/amnezia/shim-override.meta
```

---

## Exit criteria & switching back to upstream

Return to stock upstream `containerd` as soon as **all** of the following hold:
1. `containerd/ttrpc#241` (or equivalent fix) is merged upstream and released in a `ttrpc` tag.
2. Downstream `containerd` / Docker `containerd.io` packages including that fix are available via
   `apt` for the fleet's hosts.

Return procedure:
1. Upgrade host `containerd` / `containerd.io` packages during a planned node maintenance window.
2. Edit [`infra/node/shim-override/shim-override.env`](../infra/node/shim-override/shim-override.env)
   to `SHIM_OVERRIDE_MODE=upstream` (or revert the `shim-override` commit and remove the `shim_build`
   stage if permanently retiring the override).
3. Release `node-agent` normally from `main`: updating each node automatically cleans up
   `amnezia-node-shim` and leaves zero custom binary residue on the host.
4. Once no fleet host runs the override, archive `https://github.com/wyrtensi/ttrpc`.

### Manual emergency rollback on a single host

```sh
sudo rm -f /usr/bin/containerd-shim-runc-v2
sudo dpkg-divert --package amnezia-node-shim --remove --rename /usr/bin/containerd-shim-runc-v2
sudo rm -f /usr/local/lib/amnezia/containerd-shim-runc-v2 /usr/local/lib/amnezia/shim-override.meta
sudo rmdir /usr/local/lib/amnezia 2>/dev/null || true
/usr/bin/containerd-shim-runc-v2 -v
```
