import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const normalize = (text) => text.replace(/\r\n/g, "\n");
const readNodeFile = async (rel) =>
  normalize(await readFile(new URL(`../${rel}`, import.meta.url), "utf8"));

test("compose.yaml defines br-awg-egress for awg3 with backward-compatible env defaults", async () => {
  const compose = await readNodeFile("compose.yaml");
  assert.match(compose, /driver:\s*bridge/);
  assert.match(compose, /com\.docker\.network\.bridge\.name:\s*br-awg-egress/);
  assert.match(compose, /AWG3_EGRESS_MODE:\s*\$\{AWG3_EGRESS_MODE:-masquerade\}/);
  assert.match(compose, /NODE_EGRESS_SOCKET:\s*\$\{NODE_EGRESS_SOCKET:-\/run\/amnezia-egress\/egressd\.sock\}/);
  assert.doesNotMatch(compose, /(?:watchtower|\blatest\b)/i);
});

test("services/node-agent Dockerfile contains no latest tag and embeds static egressd binary", async () => {
  const dockerfile = normalize(
    await readFile(new URL("../../../services/node-agent/Dockerfile", import.meta.url), "utf8"),
  );
  assert.doesNotMatch(dockerfile, /\blatest\b/i, "preflight.sh refuses Dockerfiles containing 'latest'");
  assert.match(dockerfile, /golang:1\.24\.13-bookworm@sha256:[0-9a-f]{64}/);
  assert.match(dockerfile, /COPY --from=egressd_build \/out\/amnezia-egressd \/opt\/node-agent\/bin\/amnezia-egressd/);
  assert.match(dockerfile, /scripts\/switch-egress-mode\.sh/);
});

test("awg3-entrypoint.sh skips container MASQUERADE only in routed mode", async () => {
  const entry = await readNodeFile("scripts/awg3-entrypoint.sh");
  assert.match(entry, /EGRESS_MODE="\$\{AWG3_EGRESS_MODE:-masquerade\}"/);
  assert.match(entry, /if \[ "\$EGRESS_MODE" = "routed" \]; then/);
  assert.match(entry, /iptables -t nat -A POSTROUTING -s 10\.90\.0\.0\/22 -o eth0 -j MASQUERADE/);
});

test("switch-egress-mode.sh enforces 256 MiB disk gate, pre-switch snapshot, live toggle, and cotenants verify", async () => {
  const sw = await readNodeFile("scripts/switch-egress-mode.sh");
  assert.match(sw, /PREFLIGHT_DISK_MIN_KB:-262144/);
  assert.match(sw, /egress-state-\$ts\.json/);
  assert.match(sw, /awg3_on_bridge=1/);
  assert.match(sw, /cotenants\.sh" snapshot/);
  assert.match(sw, /cotenants\.sh" verify/);
  assert.match(sw, /revert_on_error/);
  assert.match(sw, /prune_node_backups/);
});

test("agent-update.sh snapshots and rolls back amnezia-egressd binary on health-gate failure", async () => {
  const upd = await readNodeFile("scripts/agent-update.sh");
  assert.match(upd, /EGRESSD_BACKUP="\$\{SCRATCH\}\/backup-egressd"/);
  assert.match(upd, /systemctl restart amnezia-egressd\.service/);
  assert.match(upd, /scripts\/switch-egress-mode\.sh/);
});

test("amnezia-egressd.service pins Go memory bounds and non-root UID socket access inside root dir", async () => {
  const unit = await readNodeFile("systemd/amnezia-egressd.service");
  assert.match(unit, /Environment=GOMEMLIMIT=24MiB/);
  assert.match(unit, /Environment=GOGC=50/);
  assert.match(unit, /MemoryMax=32M/);
  assert.match(unit, /--socket-uid 10001/);
  assert.match(unit, /RuntimeDirectoryMode=0755/);
});
