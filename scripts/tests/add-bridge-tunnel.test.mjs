import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../add-bridge-tunnel.sh", import.meta.url));
const executing = { skip: process.platform === "linux" ? false : "needs a POSIX shell" };

const BRIDGE = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const OTHER = "9a8b7c6d-5e4f-4a3b-9c2d-1e0f9a8b7c6d";
const FINGERPRINT = "SHA256:abcdefHostKeyFingerprint";
const HOST = "198.51.100.7";
const args = ["--bridge-id", BRIDGE, "--bridge-host", HOST, "--host-key-fingerprint", FINGERPRINT];

const write = async (path, body, mode) => {
  await writeFile(path, body);
  await chmod(path, mode);
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "add-bridge-tunnel-"));
  const bin = join(root, "bin");
  const systemd = join(root, "systemd");
  const panelEtc = join(root, "panel-etc");
  const state = join(root, "state");
  for (const dir of [bin, systemd, state]) await mkdir(dir, { recursive: true });
  await write(join(bin, "autossh"), "#!/bin/sh\n", 0o755);
  await write(
    join(bin, "ssh-keyscan"),
    `#!/bin/sh
[ ! -f "$STATE/scan-fails" ] || exit 1
echo "${HOST} ssh-ed25519 AAAAC3Nza-scanned-key"
`,
    0o755,
  );
  await write(
    join(bin, "ssh-keygen"),
    `#!/bin/sh
cat >/dev/null
echo "256 $(cat "$STATE/fingerprint") ${HOST} (ED25519)"
`,
    0o755,
  );
  await write(join(state, "fingerprint"), FINGERPRINT, 0o644);
  await write(
    join(bin, "systemctl"),
    `#!/bin/sh
echo "systemctl $*" >>"$STATE/calls"
`,
    0o755,
  );
  await write(
    join(bin, "ss"),
    `#!/bin/sh
cat "$STATE/listening" 2>/dev/null || true
`,
    0o755,
  );
  await write(
    join(bin, "curl"),
    `#!/bin/sh
echo "curl $*" >>"$STATE/calls"
[ ! -f "$STATE/dead" ] || exit 7
echo '{"ok":true}'
`,
    0o755,
  );
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STATE: state,
    AMNEZIA_SYSTEMD_DIR: systemd,
    AMNEZIA_PANEL_ETC: panelEtc,
    AMNEZIA_ALLOW_NONROOT: "1",
    AMNEZIA_TUNNEL_WAIT: "2",
    TUNNEL_BIND: "172.17.0.1",
    TUNNEL_PORT_BASE: "4105",
    PANEL_NODE_KEY: "/root/.ssh/panel_nodes_key",
  };
  return {
    root, systemd, panelEtc, state,
    run: (a, extra = {}) => spawnSync("sh", [scriptPath, ...a], { env: { ...env, ...extra }, encoding: "utf8" }),
    unit: (id = BRIDGE) => readFile(join(systemd, `panel-tunnel-bridge-${id}.service`), "utf8"),
    calls: () => readFile(join(state, "calls"), "utf8").catch(() => ""),
    flag: (name, content = "1") => writeFile(join(state, name), content),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const withHost = (name, fn) =>
  test(name, executing, async () => {
    const host = await fixture();
    try {
      await fn(host);
    } finally {
      await host.cleanup();
    }
  });

withHost("writes a supervised unit that forwards to the agent's loopback with the host key pinned", async (h) => {
  const r = h.run(args);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  const unit = await h.unit();
  assert.match(unit, /-L 172\.17\.0\.1:4105:127\.0\.0\.1:7600 root@198\.51\.100\.7/);
  assert.match(unit, /StrictHostKeyChecking=yes/);
  assert.doesNotMatch(unit, /accept-new/);
  assert.match(unit, /UserKnownHostsFile=.*bridge-known-hosts\/3f1c2a40/);
  assert.match(unit, /-i \/root\/\.ssh\/panel_nodes_key/);
  assert.match(unit, /AUTOSSH_GATETIME=0/);
  const known = await readFile(join(h.panelEtc, "bridge-known-hosts", BRIDGE), "utf8");
  assert.match(known, /ssh-ed25519 AAAAC3Nza-scanned-key/);
  assert.match(await h.calls(), /systemctl enable --now panel-tunnel-bridge-3f1c2a40/);
  assert.match(r.stdout, /management URL for the panel: http:\/\/host\.docker\.internal:4105/);
  assert.match(r.stdout, /bridge-enroll 3f1c2a40-.* --api-url=http:\/\/host\.docker\.internal:4105 --api-key-file=- --confirm/);
  assert.match(r.stdout, /cat \/etc\/amnezia-bridge\/agent\/api-token \|/);
});

withHost("a host key that does not match the printed fingerprint writes nothing", async (h) => {
  await h.flag("fingerprint", "SHA256:someoneElse");
  const r = h.run(args);
  assert.equal(r.status, 40, r.stderr);
  assert.match(r.stderr, /expected SHA256:abcdefHostKeyFingerprint/);
  assert.deepEqual(await readdir(h.systemd), []);
  await assert.rejects(stat(h.panelEtc));
  assert.equal(await h.calls(), "");
});

withHost("an unreachable host reports a scan failure", async (h) => {
  await h.flag("scan-fails");
  assert.equal(h.run(args).status, 40);
  assert.deepEqual(await readdir(h.systemd), []);
});

withHost("allocates in the node-tunnel collision domain: other units and listening sockets are skipped", async (h) => {
  await writeFile(
    join(h.systemd, "panel-tunnel-node-a.service"),
    "ExecStart=/usr/bin/autossh -M 0 -N -L 172.17.0.1:4105:127.0.0.1:4001 root@203.0.113.1\n",
  );
  await h.flag("listening", "LISTEN 0 128 127.0.0.1:4106 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:4107 0.0.0.0:*\n");
  const r = h.run(args);
  assert.equal(r.status, 0, r.stderr);
  assert.match(await h.unit(), /-L 172\.17\.0\.1:4108:127\.0\.0\.1:7600/);
});

withHost("two bridges get different ports, and a re-run keeps the unit's port", async (h) => {
  assert.equal(h.run(args).status, 0);
  const second = h.run(["--bridge-id", OTHER, "--bridge-host", "198.51.100.8", "--host-key-fingerprint", FINGERPRINT]);
  assert.equal(second.status, 0, second.stderr);
  assert.match(await h.unit(OTHER), /-L 172\.17\.0\.1:4106:/);
  // The first unit still holds 4105 on a repeat, even if lower ports are free again.
  assert.equal(h.run(args).status, 0);
  assert.match(await h.unit(), /-L 172\.17\.0\.1:4105:/);
});

withHost("a tunnel that never reaches the agent fails after the unit is written", async (h) => {
  await h.flag("dead");
  const r = h.run(args);
  assert.equal(r.status, 42, r.stderr);
  assert.match(r.stderr, /healthz did not answer/);
});

withHost("a dry run writes nothing and starts nothing", async (h) => {
  const r = h.run([...args, "--dry-run"]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /PLAN: write .*panel-tunnel-bridge-3f1c2a40/);
  assert.match(r.stdout, /-L 172\.17\.0\.1:4105:127\.0\.0\.1:7600/);
  assert.deepEqual(await readdir(h.systemd), []);
  assert.equal(await h.calls(), "");
});

withHost("rejects malformed arguments", async (h) => {
  for (const bad of [
    ["--bridge-id", "x", "--bridge-host", HOST, "--host-key-fingerprint", FINGERPRINT],
    ["--bridge-id", BRIDGE, "--bridge-host", "bridge.example.com", "--host-key-fingerprint", FINGERPRINT],
    ["--bridge-id", BRIDGE, "--bridge-host", HOST, "--host-key-fingerprint", "MD5:aa"],
    [...args, "--agent-port", "0"],
    [...args, "--bogus"],
  ]) {
    assert.equal(h.run(bad).status, 2, bad.join(" "));
  }
  // No fingerprint at all is also refused: pinning is not optional.
  assert.equal(h.run(["--bridge-id", BRIDGE, "--bridge-host", HOST]).status, 2);
});
