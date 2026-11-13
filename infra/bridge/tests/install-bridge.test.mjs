import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  const systemd = join(root, "run-systemd");
  for (const dir of [bin, join(bridgeEtc, "frp"), join(etc, "ssh"), state, systemd]) {
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
    AMNEZIA_SYSTEMD_DIR: systemd,
    BRIDGE_AGENT_IMAGE_REPOSITORY: "",
    AMNEZIA_LISTEN_WAIT: "2",
    BRIDGE_AGENT_IMAGE: "",
  };
  const run = (a, extraEnv = {}) =>
    spawnSync("sh", [scriptPath, ...a], { env: { ...env, ...extraEnv }, encoding: "utf8" });
  const agentDir = join(bridgeEtc, "agent");
  return {
    root, etc, state, bin, systemd, agentDir, run,
    pinFile: join(agentDir, "image.pin"),
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
  assert.ok(calls.indexOf("frps --bridge-id") < calls.indexOf("docker compose --project-name"), "frps runs before the agent");
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
  assert.doesNotMatch(calls, /compose .*(pull|up)/);
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
  assert.doesNotMatch(await h.calls(), /compose .*(pull|up)/);
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

withHost("host prerequisites are checked before anything is installed, each with exit 61 and the missing name", async (h) => {
  // compose plugin
  await h.flag("no-compose");
  const noCompose = h.run(withImage);
  assert.equal(noCompose.status, 61, output(noCompose));
  assert.match(noCompose.stderr, /docker-compose-plugin/);
  await rm(join(h.state, "no-compose"));

  // systemd
  await rm(h.systemd, { recursive: true });
  const noSystemd = h.run(withImage);
  assert.equal(noSystemd.status, 61, output(noSystemd));
  assert.match(noSystemd.stderr, /missing host prerequisites.*systemd/);
  await mkdir(h.systemd);

  // docker, curl and sha256sum: a PATH that holds only the tools the script needs up to that point
  const tools = join(h.root, "tools");
  await mkdir(tools);
  for (const name of ["grep", "id", "dirname", "sed", "awk", "cat", "wc", "mktemp", "mkdir", "chmod", "mv", "rm", "stat", "tr", "head", "sleep"]) {
    const found = spawnSync("sh", ["-c", `command -v ${name}`], { encoding: "utf8" }).stdout.trim();
    if (found) await symlink(found, join(tools, name));
  }
  const bare = (extra) => spawnSync("/bin/sh", [scriptPath, ...withImage], {
    env: { PATH: `${tools}${extra}`, STATE: h.state, AMNEZIA_ETC: h.etc, AMNEZIA_FRPS_INSTALLER: join(h.root, "frps-installer.sh"), AMNEZIA_ALLOW_NONROOT: "1", AMNEZIA_SYSTEMD_DIR: h.systemd },
    encoding: "utf8",
  });
  const none = bare("");
  assert.equal(none.status, 61, output(none));
  assert.match(none.stderr, /missing host prerequisites for the bridge-agent: docker curl sha256sum/);
  // Nothing was installed: frps never ran, no agent directory.
  assert.doesNotMatch(await h.calls(), /frps/);
  await assert.rejects(stat(h.agentDir));

  // docker and curl present (the stubs), sha256sum still missing
  const partial = bare(`:${h.bin}`);
  assert.equal(partial.status, 61, output(partial));
  assert.match(partial.stderr, /: sha256sum \(/);

  // a dry run refuses the same way
  const dry = h.run([...withImage, "--dry-run"], { AMNEZIA_SYSTEMD_DIR: join(h.root, "absent") });
  assert.equal(dry.status, 61, output(dry));
});

withHost("without an image no agent prerequisite is required (frps-only path)", async (h) => {
  await h.flag("no-compose");
  const r = h.run(args);
  assert.equal(r.status, 60, output(r));
});

withHost("the image must come from the approved bridge-agent repository", async (h) => {
  const digest = `@sha256:${DIGEST}`;
  // Default rule: ghcr.io/<path>/bridge-agent only.
  for (const image of [`ghcr.io/example/node-agent${digest}`, `docker.io/example/bridge-agent${digest}`, `ghcr.io/example/bridge-agent-evil${digest}`, `evil.example/ghcr.io/x/bridge-agent${digest}`]) {
    const r = h.run([...args, "--agent-image", image]);
    assert.equal(r.status, 2, image);
    assert.match(r.stderr, /bridge-agent repository/);
  }
  // A configured repository is an exact match.
  const approved = "ghcr.io/stas/panel/bridge-agent";
  const other = h.run([...args, "--agent-image", IMAGE, "--agent-repository", approved]);
  assert.equal(other.status, 2);
  assert.match(other.stderr, /not from the approved bridge-agent repository ghcr\.io\/stas\/panel\/bridge-agent/);
  const viaEnv = h.run([...args, "--agent-image", IMAGE], { BRIDGE_AGENT_IMAGE_REPOSITORY: approved });
  assert.equal(viaEnv.status, 2);
  assert.equal(await h.calls(), "", "refused before frps ran");
  const ok = h.run([...args, "--agent-image", `${approved}${digest}`, "--agent-repository", approved]);
  assert.equal(ok.status, 0, output(ok));
});

withHost("the pin file records the approved repository and the running digest, only after the agent is healthy", async (h) => {
  const r = h.run(withImage);
  assert.equal(r.status, 0, output(r));
  const pin = await readFile(h.pinFile, "utf8");
  assert.match(pin, /^BRIDGE_AGENT_IMAGE_REPOSITORY=ghcr\.io\/example\/bridge-agent$/m);
  assert.match(pin, new RegExp(`^BRIDGE_AGENT_IMAGE=${IMAGE}$`, "m"));
  assert.equal((await stat(h.pinFile)).mode & 0o777, 0o600);
  assert.match(r.stdout, new RegExp(`pinned image:\\s+sha256:${DIGEST}`));

  // A failed agent leaves an earlier, known-good pin untouched and writes none over it.
  const second = await fixture();
  try {
    await mkdir(second.agentDir, { recursive: true });
    const earlier = "BRIDGE_AGENT_IMAGE_REPOSITORY=ghcr.io/example/bridge-agent\nBRIDGE_AGENT_IMAGE=ghcr.io/example/bridge-agent@sha256:" + "b".repeat(64) + "\n";
    await write(second.pinFile, earlier, 0o600);
    await second.flag("unhealthy");
    assert.equal(second.run(withImage).status, 64);
    assert.equal(await readFile(second.pinFile, "utf8"), earlier);
  } finally {
    await second.cleanup();
  }
});

withHost("a dry run plans the pin file without writing it", async (h) => {
  const r = h.run([...withImage, "--dry-run"]);
  assert.match(r.stdout, /PLAN: write the pin file .*image\.pin .*repository ghcr\.io\/example\/bridge-agent/);
  await assert.rejects(stat(h.pinFile));
});
