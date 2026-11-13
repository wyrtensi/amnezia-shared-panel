import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../install-bridge.sh", import.meta.url));
const composePath = fileURLToPath(new URL("../compose.yaml", import.meta.url));
const executing = { skip: process.platform === "linux" ? false : "needs a POSIX shell" };

const BRIDGE = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const DIGEST = "a".repeat(64);
const IMAGE = `ghcr.io/example/bridge-agent@sha256:${DIGEST}`;
const args = ["--bridge-id", BRIDGE, "--control-port", "7000", "--udp-start", "41000", "--udp-end", "41031"];
const withImage = [...args, "--agent-image", IMAGE];

const write = async (path, body, mode) => {
  await writeFile(path, body);
  await chmod(path, mode);
};

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "install-bridge-"));
  const bin = join(root, "bin");
  const etc = join(root, "etc");
  const bridgeEtc = join(etc, "amnezia-bridge");
  const state = join(root, "state");
  for (const dir of [bin, join(bridgeEtc, "frp"), join(etc, "ssh"), state]) {
    await mkdir(dir, { recursive: true });
  }
  await write(join(bridgeEtc, "frp", "dashboard.env"), "FRPS_DASHBOARD_USER=u\nFRPS_DASHBOARD_PASSWORD=p\n", 0o600);
  await write(join(etc, "ssh", "ssh_host_ed25519_key.pub"), "ssh-ed25519 AAAA test\n", 0o644);

  // The frps installer is its own tested script; here it only records how it was called.
  await write(
    join(root, "frps-installer.sh"),
    `#!/bin/sh
echo "frps $*" >>"$STATE/calls"
echo "frps installer ran"
exit "$(cat "$STATE/frps-rc" 2>/dev/null || echo 0)"
`,
    0o755,
  );
  await write(
    join(bin, "docker"),
    `#!/bin/sh
echo "docker $*" >>"$STATE/calls"
[ "$1" = compose ] || exit 99
shift
case "$*" in
  version) [ ! -f "$STATE/no-compose" ] ;;
  *" pull"*) [ ! -f "$STATE/pull-fails" ] ;;
  *" up -d"*) [ ! -f "$STATE/up-fails" ] || exit 1; touch "$STATE/agent-up" ;;
  *) exit 98 ;;
esac
`,
    0o755,
  );
  await write(
    join(bin, "ss"),
    `#!/bin/sh
[ -f "$STATE/agent-up" ] && [ ! -f "$STATE/no-listen" ] || exit 0
if [ -f "$STATE/wide-listen" ]; then echo "LISTEN 0 511 0.0.0.0:7600 0.0.0.0:*"; else echo "LISTEN 0 511 127.0.0.1:7600 0.0.0.0:*"; fi
`,
    0o755,
  );
  await write(
    join(bin, "curl"),
    `#!/bin/sh
echo "curl $*" >>"$STATE/calls"
[ ! -f "$STATE/unhealthy" ] || exit 22
echo '{"ok":true}'
`,
    0o755,
  );
  await write(join(bin, "ssh-keygen"), `#!/bin/sh\necho "256 SHA256:abcdefHostKeyFingerprint root@host (ED25519)"\n`, 0o755);

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STATE: state,
    AMNEZIA_ETC: etc,
    AMNEZIA_FRPS_INSTALLER: join(root, "frps-installer.sh"),
    AMNEZIA_ALLOW_NONROOT: "1",
    AMNEZIA_LISTEN_WAIT: "2",
    BRIDGE_AGENT_IMAGE: "",
  };
  const run = (a, extraEnv = {}) =>
    spawnSync("sh", [scriptPath, ...a], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  const agentDir = join(bridgeEtc, "agent");
  return {
    root, etc, state, agentDir, run,
    token: join(agentDir, "api-token"),
    envFile: join(agentDir, "agent.env"),
    calls: () => readFile(join(state, "calls"), "utf8").catch(() => ""),
    flag: (name) => writeFile(join(state, name), "1"),
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

const output = (r) => r.stdout + r.stderr;

withHost("installs frps first, then the agent, and prints only safe enrollment metadata", async (h) => {
  const r = h.run(withImage);
  assert.equal(r.status, 0, output(r));
  const calls = await h.calls();
  assert.ok(calls.indexOf("frps --bridge-id") < calls.indexOf("docker compose"), "frps runs before the agent");
  assert.match(calls, new RegExp(`frps --bridge-id ${BRIDGE} --control-port 7000 --udp-start 41000 --udp-end 41031\\n`));
  assert.match(calls, /docker compose --project-name amnezia-bridge-agent --env-file .*agent\.env -f .*compose\.yaml up -d/);

  const token = (await readFile(h.token, "utf8")).trim();
  assert.match(token, /^[A-Za-z0-9]{48}$/);
  assert.equal((await stat(h.token)).mode & 0o777, 0o600);

  const envFile = await readFile(h.envFile, "utf8");
  assert.match(envFile, new RegExp(`^BRIDGE_AGENT_IMAGE=${IMAGE}$`, "m"));
  assert.match(envFile, new RegExp(`^BRIDGE_ID=${BRIDGE}$`, "m"));
  assert.match(envFile, /^BRIDGE_APPLIED_CONTROL_PORT=7000$/m);
  assert.match(envFile, /^BRIDGE_APPLIED_UDP_START=41000$/m);
  assert.match(envFile, /^BRIDGE_APPLIED_UDP_END=41031$/m);
  assert.equal((await stat(h.envFile)).mode & 0o777, 0o600);
  assert.ok(!envFile.includes(token), "the env file holds no secret");

  // Safe metadata only: id, loopback listener, token file path, host key fingerprint.
  assert.match(r.stdout, new RegExp(`bridge id:\\s+${BRIDGE}`));
  assert.match(r.stdout, /127\.0\.0\.1:7600 \(loopback only\)/);
  assert.match(r.stdout, /api-token \(mode 0600; the value is not printed\)/);
  assert.match(r.stdout, /SHA256:abcdefHostKeyFingerprint/);
  assert.ok(!output(r).includes(token), "the token never reaches the output");
  assert.ok(!(await calls).includes(token), "the token is never a command argument");
});

withHost("the compose service is loopback-only, root-readable, locked down and digest-pinned", async () => {
  const compose = await readFile(composePath, "utf8");
  assert.match(compose, /network_mode: host/);
  assert.doesNotMatch(compose, /^\s*ports:/m);
  assert.match(compose, /user: "0:0"/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /image: \$\{BRIDGE_AGENT_IMAGE:\?/);
  assert.match(compose, /BRIDGE_AGENT_LISTEN: 127\.0\.0\.1:/);
  assert.match(compose, /api-token:\/etc\/amnezia-bridge\/agent\/api-token:ro/);
  assert.match(compose, /dashboard\.env:\/etc\/amnezia-bridge\/frp\/dashboard\.env:ro/);
  assert.doesNotMatch(compose, /BRIDGE_AGENT_API_TOKEN=/);
});

withHost("a dry run plans both parts and generates, pulls, writes and starts nothing", async (h) => {
  const r = h.run([...withImage, "--dry-run"]);
  assert.equal(r.status, 0, output(r));
  assert.match(r.stdout, /PLAN: generate API token/);
  assert.match(r.stdout, /PLAN: write .*agent\.env/);
  assert.match(r.stdout, /PLAN: docker compose pull and up -d/);
  const calls = await h.calls();
  assert.match(calls, /frps .* --dry-run/);
  assert.doesNotMatch(calls, /docker/);
  await assert.rejects(stat(h.agentDir));
});

withHost("re-running keeps the same token and never prints it", async (h) => {
  assert.equal(h.run(withImage).status, 0);
  const token = await readFile(h.token, "utf8");
  const again = h.run(withImage);
  assert.equal(again.status, 0, output(again));
  assert.equal(await readFile(h.token, "utf8"), token);
  assert.ok(!output(again).includes(token.trim()));
});

withHost("an image that is not pinned by digest is refused before anything runs", async (h) => {
  for (const image of ["ghcr.io/example/bridge-agent:latest", "ghcr.io/example/bridge-agent", `ghcr.io/example/x@sha256:${"a".repeat(63)}`, "x@sha256:" + "G".repeat(64)]) {
    const r = h.run([...args, "--agent-image", image]);
    assert.equal(r.status, 2, image);
    assert.match(r.stderr, /pinned by digest/);
  }
  assert.equal(await h.calls(), "");
});

withHost("no image: frps is installed, the agent is explicitly not, exit 60", async (h) => {
  const r = h.run(args);
  assert.equal(r.status, 60, output(r));
  assert.match(r.stdout, /bridge-agent NOT installed/);
  assert.match(await h.calls(), /^frps /);
  assert.doesNotMatch(await h.calls(), /docker/);
  const dry = h.run([...args, "--dry-run"]);
  assert.equal(dry.status, 0);
  assert.match(dry.stdout, /bridge-agent NOT planned/);
});

withHost("BRIDGE_AGENT_IMAGE is read from the environment", async (h) => {
  const r = h.run(args, { BRIDGE_AGENT_IMAGE: IMAGE });
  assert.equal(r.status, 0, output(r));
  assert.match(await readFile(h.envFile, "utf8"), new RegExp(IMAGE));
});

withHost("a failing frps step stops before the agent and keeps its exit code", async (h) => {
  await h.flag("frps-rc");
  await writeFile(join(h.state, "frps-rc"), "21");
  const r = h.run(withImage);
  assert.equal(r.status, 21);
  assert.doesNotMatch(await h.calls(), /docker/);
  await assert.rejects(stat(h.agentDir));
});

withHost("an agent that does not start fails with its own code and leaves frps alone", async (h) => {
  await h.flag("up-fails");
  const up = h.run(withImage);
  assert.equal(up.status, 63, output(up));
  assert.match(up.stderr, /frps is unaffected/);

  await rm(join(h.state, "up-fails"));
  await h.flag("no-listen");
  const silent = h.run(withImage);
  assert.equal(silent.status, 64, output(silent));
  assert.match(silent.stderr, /nothing listens on 127\.0\.0\.1:7600/);

  // frps is never touched again after its own step: no rollback calls.
  assert.doesNotMatch(await h.calls(), /frps .*(rollback|remove)|compose .* down/);
});

withHost("a listener on a wider address than loopback does not count", async (h) => {
  await h.flag("wide-listen");
  const r = h.run(withImage);
  assert.equal(r.status, 64, output(r));
});

withHost("a failing health check fails the install", async (h) => {
  await h.flag("unhealthy");
  const r = h.run(withImage);
  assert.equal(r.status, 64, output(r));
  assert.match(r.stderr, /healthz did not answer ok/);
});

withHost("missing compose, an unsafe token file and a missing dashboard.env each have a clear exit", async (h) => {
  await h.flag("no-compose");
  assert.equal(h.run(withImage).status, 61);
  await rm(join(h.state, "no-compose"));

  await mkdir(h.agentDir, { recursive: true });
  await write(h.token, `${"t".repeat(48)}\n`, 0o644);
  const loose = h.run(withImage);
  assert.equal(loose.status, 62, output(loose));
  assert.match(loose.stderr, /expected 0600/);
  assert.doesNotMatch(output(loose), /t{48}/);

  await rm(join(h.etc, "amnezia-bridge", "frp", "dashboard.env"));
  await chmod(h.token, 0o600);
  assert.equal(h.run(withImage).status, 62);
});

withHost("rejects bad arguments before running anything", async (h) => {
  for (const bad of [
    ["--bridge-id", "nope", ...args.slice(2)],
    [...args, "--agent-port", "0"],
    [...args, "--agent-port", "7500"],
    [...args, "--bogus"],
  ]) {
    assert.equal(h.run(bad).status, 2);
  }
  assert.equal(await h.calls(), "");
  assert.deepEqual(await readdir(h.etc), ["amnezia-bridge", "ssh"]);
});
