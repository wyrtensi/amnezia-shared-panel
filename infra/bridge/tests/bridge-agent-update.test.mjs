import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptUrl = new URL("../bridge-agent-update.sh", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const serviceUrl = new URL("../systemd/amnezia-bridge-agent-update.service", import.meta.url);
const pathUnitUrl = new URL("../systemd/amnezia-bridge-agent-update.path", import.meta.url);

// Same guard as the node-agent updater tests: bash, flock (util-linux), GNU
// date and /proc. Docker, curl and systemctl are always PATH stubs: nothing
// here reaches this host's real Docker or systemd.
const canExecute = process.platform === "linux" && spawnSync("flock", ["--version"]).status === 0;
const executing = { skip: canExecute ? false : "needs Linux bash + flock" };
const realDate = spawnSync("sh", ["-c", "command -v date"], { encoding: "utf8" }).stdout.trim();

const exists = (path) => lstat(path).then(() => true, () => false);

const REPO = "ghcr.io/example/panel/bridge-agent";
const BRIDGE = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const OLD_HEX = "1".repeat(64);
const NEW_HEX = "2".repeat(64);
const OLD_IMAGE = `${REPO}@sha256:${OLD_HEX}`;
const NEW_IMAGE = `${REPO}@sha256:${NEW_HEX}`;
const OP = "0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";
const OP2 = "1c7a0b63-4d2e-4f8b-8c99-2a3b4c5d6e7f";
// Looks like the installer's token (48 alphanumerics); must never reach argv, a result or the journal.
const TOKEN = "Tk9sEcReT0kEn".padEnd(48, "Q");
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;

const AGENT_ENV = (image) =>
  [
    "# Written by install-bridge.sh. No secrets: the API token lives in the token file.",
    `BRIDGE_AGENT_IMAGE=${image}`,
    "BRIDGE_ETC=/etc/amnezia-bridge",
    `BRIDGE_ID=${BRIDGE}`,
    "BRIDGE_APPLIED_CONTROL_PORT=7000",
    "BRIDGE_APPLIED_UDP_START=41000",
    "BRIDGE_APPLIED_UDP_END=41031",
    "BRIDGE_AGENT_PORT=7600",
    `BRIDGE_AGENT_IMAGE_REPOSITORY=${REPO}`,
    "",
  ].join("\n");
const PIN = (image, repository = REPO) =>
  `# pin\nBRIDGE_AGENT_IMAGE_REPOSITORY=${repository}\nBRIDGE_AGENT_IMAGE=${image}\n`;

const FAKE_DOCKER = `#!/usr/bin/env bash
# Fake docker: records every call, keeps "pulled images" and "the running
# container" as files, answers only what the updater asks.
printf '%s\\n' "$*" >>"$FAKE/docker.log"
hex() { printf '%s' "\${1##*sha256:}"; }
listed() { for d in \${2:-}; do [ "$(hex "$1")" = "$d" ] && return 0; done; return 1; }
case "$1" in
  pull)
    ref="\${!#}"
    [ -z "\${FAKE_PULL_FAILS:-}" ] || exit 1
    echo "$ref" >>"$FAKE/images"
    exit 0 ;;
  image)
    fmt="$4"; ref="$5"
    grep -qxF "$ref" "$FAKE/images" 2>/dev/null || exit 1
    case "$fmt" in
      *Os*) echo "\${FAKE_PLATFORM:-linux/amd64}" ;;
      *Id*) echo "sha256:id-$(hex "$ref")" ;;
    esac
    exit 0 ;;
  inspect)
    [ -f "$FAKE/running" ] || exit 1
    ref="$(cat "$FAKE/running")"
    echo "\${ref}|sha256:id-$(hex "$ref")|true"
    exit 0 ;;
  compose)
    env_file=""
    prev=""
    for arg in "$@"; do [ "$prev" = "--env-file" ] && env_file="$arg"; prev="$arg"; done
    image="$(sed -n 's/^BRIDGE_AGENT_IMAGE=//p' "$env_file" | tail -n 1)"
    printf 'up %s\\n' "$image" >>"$FAKE/ups"
    if listed "$image" "\${FAKE_UP_FAILS:-}"; then exit 1; fi
    if [ -n "\${FAKE_UP_SLEEP:-}" ]; then echo started >"$FAKE/marker"; sleep "$FAKE_UP_SLEEP"; fi
    [ -z "\${FAKE_LOCK_DIR_ON_UP:-}" ] || chmod 0500 "$FAKE_LOCK_DIR_ON_UP"
    grep -qxF "$image" "$FAKE/images" 2>/dev/null || echo "$image" >>"$FAKE/images"
    echo "$image" >"$FAKE/running"
    exit 0 ;;
esac
exit 0
`;

// Fake curl: the updater passes the token in a config on stdin (-K -).
const FAKE_CURL = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$FAKE/curl.log"
config="$(cat)"
case "$config" in *"Authorization: Bearer $FAKE_TOKEN"*) ;; *) exit 22 ;; esac
hex() { printf '%s' "\${1##*sha256:}"; }
listed() { for d in \${2:-}; do [ "$(hex "$1")" = "$d" ] && return 0; done; return 1; }
image="$(cat "$FAKE/running" 2>/dev/null)"
if listed "$image" "\${FAKE_BROKEN:-}"; then exit 7; fi
reachable=true
if listed "$image" "\${FAKE_FRPS_DOWN:-}"; then reachable=false; fi
bridge="$FAKE_BRIDGE"
if listed "$image" "\${FAKE_WRONG_IDENTITY:-}"; then bridge="9e8d7c6b-5a49-4382-9170-6f5e4d3c2b1a"; fi
case "\${!#}" in
  */v1/identity)
    caps='"status.v1","update.v1"'
    if listed "$image" "\${FAKE_NO_UPDATE_CAP:-}"; then caps='"status.v1"'; fi
    printf '{"bridgeId":"%s","agentVersion":"0.2.0","apiVersion":1,"capabilities":[%s]}' "$bridge" "$caps" ;;
  */v1/status) printf '{"bridgeId":"%s","agentVersion":"0.2.0","apiVersion":1,"observedAt":"t","frps":{"reachable":%s,"version":"0.72.0"},"applied":{},"proxies":[],"errors":[]}' "$bridge" "$reachable" ;;
  *) exit 22 ;;
esac
`;

// Fake date: \`+%s%3N\` without -d is "now"; a test can script its values.
const FAKE_DATE = (real) => `#!/usr/bin/env bash
if [ -f "$FAKE/clock" ] && [ "$*" = "-u +%s%3N" ]; then
  value="$(head -n 1 "$FAKE/clock")"
  if [ -n "$value" ]; then
    tail -n +2 "$FAKE/clock" >"$FAKE/clock.next"; mv "$FAKE/clock.next" "$FAKE/clock"
    echo "$value"; exit 0
  fi
fi
exec ${real} "$@"
`;

const fixture = async ({ envImage = OLD_IMAGE, pin = PIN(OLD_IMAGE), running = OLD_IMAGE } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "bridge-agent-update-"));
  const bridgeDir = join(root, "opt");
  const bridgeEtc = join(root, "etc", "amnezia-bridge");
  const agentDir = join(bridgeEtc, "agent");
  const spool = join(root, "spool");
  const stateDir = join(root, "updater");
  const lockDir = join(root, "lock");
  const bin = join(root, "bin");
  const fake = join(root, "fake");
  for (const dir of [bridgeDir, agentDir, join(spool, "requests"), join(spool, "results"), bin, fake]) {
    await mkdir(dir, { recursive: true });
  }
  await writeFile(join(bridgeDir, "compose.yaml"), "services:\n  bridge-agent: {}\n");
  await writeFile(join(agentDir, "agent.env"), AGENT_ENV(envImage), { mode: 0o600 });
  if (pin !== null) await writeFile(join(agentDir, "image.pin"), pin, { mode: 0o600 });
  await writeFile(join(agentDir, "api-token"), `${TOKEN}\n`, { mode: 0o600 });
  await writeFile(join(fake, "images"), `${OLD_IMAGE}\n`);
  if (running) await writeFile(join(fake, "running"), `${running}\n`);
  for (const [name, body] of [
    ["docker", FAKE_DOCKER],
    ["curl", FAKE_CURL],
    ["systemctl", `#!/bin/sh\necho "systemctl $*" >>"$FAKE/systemctl.log"\n`],
    ["date", FAKE_DATE(realDate)],
  ]) {
    await writeFile(join(bin, name), body);
    await chmod(join(bin, name), 0o755);
  }

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AMNEZIA_BRIDGE_DIR: bridgeDir,
    AMNEZIA_BRIDGE_ETC: bridgeEtc,
    BRIDGE_UPDATE_SPOOL_DIR: spool,
    BRIDGE_UPDATER_STATE_DIR: stateDir,
    BRIDGE_UPDATER_LOCK_DIR: lockDir,
    BRIDGE_AGENT_UPDATE_REPO: REPO,
    BRIDGE_AGENT_HEALTH_ATTEMPTS: "2",
    BRIDGE_AGENT_HEALTH_INTERVAL: "0",
    FAKE: fake,
    FAKE_BRIDGE: BRIDGE,
    FAKE_TOKEN: TOKEN,
  };

  const requestPath = (id = OP) => join(spool, "requests", `${id}.json`);
  const request = (fields = {}, id = OP) =>
    writeFile(
      requestPath(id),
      `${JSON.stringify({
        operationId: id,
        imageRepository: REPO,
        imageDigest: `sha256:${NEW_HEX}`,
        notAfter: new Date(Date.now() + 120_000).toISOString(),
        receivedAt: new Date().toISOString(),
        ...fields,
      })}\n`,
      { mode: 0o600 },
    );
  const run = (extra = {}) => spawnSync("bash", [scriptPath], { env: { ...env, ...extra }, encoding: "utf8" });
  const lines = async (name) => (await readFile(join(fake, name), "utf8").catch(() => "")).split("\n").filter(Boolean);
  const result = async (id = OP) => JSON.parse(await readFile(join(spool, "results", `${id}.json`), "utf8"));
  const agentEnv = () => readFile(join(agentDir, "agent.env"), "utf8");
  const pinFile = () => readFile(join(agentDir, "image.pin"), "utf8");
  const journal = join(stateDir, "journal");
  const writeJournal = async (fields) => {
    await mkdir(stateDir, { recursive: true });
    await writeFile(
      journal,
      Object.entries({
        OPERATION_ID: OP,
        REPOSITORY: REPO,
        DIGEST: `sha256:${NEW_HEX}`,
        NOT_AFTER: new Date(Date.now() + 60_000).toISOString(),
        PREVIOUS: OLD_IMAGE,
        ...fields,
      })
        .map(([key, value]) => `${key}=${value}\n`)
        .join(""),
    );
  };

  return {
    root, spool, stateDir, lockDir, agentDir, fake, env, journal,
    requestPath, request, run, lines, result, agentEnv, pinFile, writeJournal,
    states: (run) => [...run.stdout.matchAll(/operation [0-9a-f-]{36}: ([a-z_]+)/g)].map((m) => m[1]),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const withHost = (name, options, fn) =>
  test(name, executing, async () => {
    const host = await fixture(typeof options === "function" ? {} : options);
    try {
      await (typeof options === "function" ? options : fn)(host);
    } finally {
      await host.cleanup();
    }
  });

/** Properties every run must keep: frps untouched, the token never leaked, results bounded. */
const assertInvariants = async (h, run) => {
  assert.deepEqual(await h.lines("systemctl.log"), [], "the updater never calls systemctl (frps is never restarted)");
  for (const call of await h.lines("docker.log")) {
    assert.doesNotMatch(call, /frps/, call);
    assert.doesNotMatch(call, /\b(rmi|rm|prune)\b/, `no image or container is removed: ${call}`);
    if (call.startsWith("compose")) {
      assert.match(call, /--project-name amnezia-bridge-agent .* up --detach --no-deps --no-build bridge-agent$/, call);
    }
  }
  const argv = [...(await h.lines("docker.log")), ...(await h.lines("curl.log"))].join("\n");
  assert.ok(!argv.includes(TOKEN), "the token is never a command argument");
  assert.ok(!(run.stdout + run.stderr).includes(TOKEN), "the token never reaches the journal output");
  for (const name of await readdir(join(h.spool, "results"))) {
    const text = await readFile(join(h.spool, "results", name), "utf8");
    assert.ok(!text.includes(TOKEN));
    const body = JSON.parse(text);
    assert.equal(name, `${body.operationId}.json`, "a result is filed under its own operation id");
    if (body.errorCode !== undefined) assert.match(body.errorCode, ERROR_CODE);
  }
  if (await exists(h.journal)) assert.ok(!(await readFile(h.journal, "utf8")).includes(TOKEN));
};

// ---------------------------------------------------------------- static ----

test("the lock lives outside the agent-writable spool and is opened read-only", async () => {
  const script = await readFile(scriptUrl, "utf8");
  assert.doesNotMatch(script, /exec 9>/);
  assert.match(script, /BRIDGE_UPDATER_LOCK_DIR:-\/run\/amnezia-bridge-updater/);
  assert.match(script, /exec 9<"\$LOCK_DIR"/);
  assert.match(script, /chmod 0700 "\$LOCK_DIR"/);
  assert.match(script, /flock -n 9/);
});

test("a request is verified through /proc after being opened once", async () => {
  const script = await readFile(scriptUrl, "utf8");
  assert.match(script, /exec 8<"\$path"/);
  assert.match(script, /\/proc\/\$\$\/fd\/8/);
});

test("only the bridge-agent service is ever recreated, never frps, and no image is removed", async () => {
  const script = await readFile(scriptUrl, "utf8");
  const code = script.split("\n").filter((line) => !/^\s*#/.test(line)).join("\n");
  const ups = code.match(/^.*compose[^\n]*\bup\b.*$/gm) ?? [];
  assert.ok(ups.length >= 1);
  for (const line of ups) assert.match(line, /--no-deps --no-build "\$AGENT_SERVICE"/, line);
  assert.match(script, /^AGENT_SERVICE=bridge-agent$/m);
  assert.doesNotMatch(script, /systemctl|frps\.service|docker (image )?(rm|rmi|prune)|docker\.sock/);
});

test("the approved repository comes from the unit, never from the pin or the request", async () => {
  const script = await readFile(scriptUrl, "utf8");
  assert.match(script, /UPDATE_REPO="\$\{BRIDGE_AGENT_UPDATE_REPO:-\}"/);
  assert.doesNotMatch(script, /env_value BRIDGE_AGENT_IMAGE_REPOSITORY/);
  assert.match(script, /\$OP_REPO" != "\$UPDATE_REPO"/);
});

test("the units use an explicit /bin/bash and watch the request spool and the journal", async () => {
  const service = await readFile(serviceUrl, "utf8");
  assert.match(service, /^ExecStart=\/bin\/bash \/opt\/amnezia-bridge\/bridge-agent-update\.sh$/m);
  assert.match(service, /^Type=oneshot$/m);
  assert.match(service, /^Environment=BRIDGE_AGENT_UPDATE_REPO=$/m, "rendered by install-bridge.sh");
  assert.match(service, /^TimeoutStartSec=\d+$/m);
  const path = await readFile(pathUnitUrl, "utf8");
  assert.match(path, /^PathExistsGlob=\/var\/lib\/amnezia-bridge\/update\/requests\/\*\.json$/m);
  assert.match(path, /^PathExists=\/var\/lib\/amnezia-bridge\/updater\/journal$/m);
  assert.match(path, /^Unit=amnezia-bridge-agent-update\.service$/m);
});

// ------------------------------------------------------------- upgrade ----

withHost("a known-good upgrade pulls by digest, recreates only the agent, verifies it and moves the pin", async (h) => {
  await h.request();
  const run = h.run();
  assert.equal(run.status, 0, run.stderr + run.stdout);

  assert.deepEqual(h.states(run), ["queued", "picked_up", "staging", "replacing", "health_check", "succeeded"]);
  const result = await h.result();
  assert.deepEqual(Object.keys(result).sort(), ["imageDigest", "imageRepository", "notAfter", "operationId", "state", "updatedAt"]);
  assert.equal(result.operationId, OP);
  assert.equal(result.state, "succeeded");
  assert.equal(result.imageDigest, `sha256:${NEW_HEX}`);

  const calls = await h.lines("docker.log");
  assert.ok(calls.includes(`pull --platform linux/amd64 ${NEW_IMAGE}`), calls.join("\n"));
  assert.deepEqual(await h.lines("ups"), [`up ${NEW_IMAGE}`], "exactly one replacement");

  const env = await h.agentEnv();
  assert.ok(env.split("\n").includes(`BRIDGE_AGENT_IMAGE=${NEW_IMAGE}`));
  assert.match(env, /^# Written by install-bridge\.sh/m, "the rest of agent.env survives");
  assert.match(env, new RegExp(`^BRIDGE_ID=${BRIDGE}$`, "m"));
  assert.equal((await stat(join(h.agentDir, "agent.env"))).mode & 0o777, 0o600);
  assert.match(await h.pinFile(), new RegExp(`^BRIDGE_AGENT_IMAGE_REPOSITORY=${REPO}\nBRIDGE_AGENT_IMAGE=${NEW_IMAGE}$`, "m"));
  assert.equal((await stat(join(h.agentDir, "image.pin"))).mode & 0o777, 0o600);

  assert.equal(await exists(h.requestPath()), false, "a finished request is removed (re-arms the path unit)");
  assert.equal(await exists(h.journal), false);
  // The health gate read identity and status with the token from stdin.
  assert.deepEqual((await h.lines("curl.log")).map((l) => l.split(" ").pop()), [
    "http://127.0.0.1:7600/v1/identity",
    "http://127.0.0.1:7600/v1/status",
  ]);
  await assertInvariants(h, run);
});

withHost("a no-op (same digest) recreates nothing and succeeds only after the checks", { envImage: NEW_IMAGE, running: NEW_IMAGE }, async (h) => {
  await writeFile(join(h.fake, "images"), `${OLD_IMAGE}\n${NEW_IMAGE}\n`);
  await h.request();
  const run = h.run();
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(h.states(run), ["queued", "picked_up", "health_check", "succeeded"]);
  assert.equal((await h.result()).state, "succeeded");
  assert.deepEqual(await h.lines("ups"), [], "a healthy current agent is not restarted");
  assert.equal((await h.lines("docker.log")).some((c) => c.startsWith("pull")), false);
  assert.match(await h.pinFile(), new RegExp(`^BRIDGE_AGENT_IMAGE=${NEW_IMAGE}$`, "m"));
  await assertInvariants(h, run);
});

withHost("a no-op on an unhealthy agent fails without touching it", { envImage: NEW_IMAGE, running: NEW_IMAGE }, async (h) => {
  await writeFile(join(h.fake, "images"), `${OLD_IMAGE}\n${NEW_IMAGE}\n`);
  await h.request();
  const run = h.run({ FAKE_FRPS_DOWN: NEW_HEX });
  const result = await h.result();
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "CURRENT_AGENT_UNHEALTHY");
  assert.deepEqual(await h.lines("ups"), []);
  assert.match(await h.pinFile(), new RegExp(`^BRIDGE_AGENT_IMAGE=${OLD_IMAGE}$`, "m"), "the pin is not moved");
  await assertInvariants(h, run);
});

// ------------------------------------------------------------ rejection ----

for (const [name, digest] of [
  ["a tag", "1.2.3"],
  ["a short digest", `sha256:${"2".repeat(63)}`],
  ["an uppercase digest", `sha256:${"A".repeat(64)}`],
]) {
  withHost(`${name} is refused before anything is pulled`, async (h) => {
    await h.request({ imageDigest: digest });
    const run = h.run();
    const result = await h.result();
    assert.equal(result.operationId, OP);
    assert.equal(result.state, "failed");
    assert.equal(result.errorCode, "DIGEST_INVALID");
    assert.equal(result.imageDigest, undefined, "an invalid value is never echoed into the result");
    assert.deepEqual(await h.lines("docker.log"), []);
    assert.equal(await exists(h.requestPath()), false);
    assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`));
    await assertInvariants(h, run);
  });
}

withHost("a repository other than the unit's approved one is refused, whatever the pin says", async (h) => {
  const evil = "ghcr.io/evil/panel/bridge-agent";
  await writeFile(join(h.agentDir, "image.pin"), PIN(OLD_IMAGE, evil));
  await h.request({ imageRepository: evil });
  const run = h.run();
  const result = await h.result();
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "REPOSITORY_NOT_APPROVED");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("an unconfigured updater refuses every request", async (h) => {
  await h.request();
  const run = h.run({ BRIDGE_AGENT_UPDATE_REPO: "" });
  assert.equal((await h.result()).errorCode, "UPDATER_NOT_CONFIGURED");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("a body for another operation id than its file name is refused", async (h) => {
  await h.request({ operationId: OP2 });
  const run = h.run();
  const result = await h.result();
  assert.equal(result.operationId, OP, "the result belongs to the file's operation, never the body's");
  assert.equal(result.errorCode, "OPERATION_MISMATCH");
  assert.equal(await exists(join(h.spool, "results", `${OP2}.json`)), false);
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("a malformed deadline is refused", async (h) => {
  await h.request({ notAfter: "tomorrow" });
  const run = h.run();
  assert.equal((await h.result()).errorCode, "NOT_AFTER_INVALID");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("no known-good pin: nothing is pulled, there would be nothing to roll back to", { pin: null }, async (h) => {
  await h.request();
  const run = h.run();
  assert.equal((await h.result()).errorCode, "NO_KNOWN_GOOD_PIN");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("a symlinked request is refused without being read", async (h) => {
  const secret = join(h.root, "secret.json");
  await writeFile(secret, JSON.stringify({ operationId: OP, imageRepository: REPO, imageDigest: `sha256:${NEW_HEX}` }));
  await symlink(secret, h.requestPath());
  const run = h.run();
  assert.equal(run.status, 0);
  assert.match(run.stdout, /not a regular spool file/);
  assert.equal((await h.result()).errorCode, "REQUEST_NOT_REGULAR_FILE");
  assert.equal(await exists(h.requestPath()), false);
  assert.equal(await exists(secret), true, "the link target is never touched");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("a planted FIFO or directory is removed without blocking the updater", async (h) => {
  spawnSync("mkfifo", [h.requestPath()]);
  await mkdir(h.requestPath(OP2));
  const run = spawnSync("bash", [scriptPath], { env: h.env, encoding: "utf8", timeout: 10_000 });
  assert.equal(run.status, 0, `${run.error ?? ""}${run.stderr}`);
  assert.deepEqual(await readdir(join(h.spool, "requests")), []);
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("junk names are drained, the agent's temp files are left alone", async (h) => {
  await writeFile(join(h.spool, "requests", "not-an-id.json"), "{}");
  await writeFile(join(h.spool, "requests", `.${OP}.abcdef.tmp`), "{}");
  const run = h.run();
  assert.equal(run.status, 0);
  assert.deepEqual(await readdir(join(h.spool, "requests")), [`.${OP}.abcdef.tmp`]);
  assert.deepEqual(await readdir(join(h.spool, "results")), []);
  await assertInvariants(h, run);
});

withHost("a file name that only starts with an operation id is junk, not that operation", async (h) => {
  await writeFile(join(h.spool, "requests", `${OP}\nx.json`), JSON.stringify({ operationId: OP }));
  const run = h.run();
  assert.equal(run.status, 0);
  assert.deepEqual(await readdir(join(h.spool, "requests")), []);
  assert.deepEqual(await readdir(join(h.spool, "results")), [], "no result under a forged name");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

// -------------------------------------------------------------- deadline ----

withHost("an intent already past notAfter is answered expired and never claimed", async (h) => {
  await h.request({ notAfter: new Date(Date.now() - 1000).toISOString() });
  const run = h.run();
  assert.deepEqual(h.states(run), ["expired"]);
  const result = await h.result();
  assert.equal(result.state, "expired");
  assert.equal(result.operationId, OP);
  assert.deepEqual(await h.lines("docker.log"), []);
  assert.equal(await exists(h.requestPath()), false);
  await assertInvariants(h, run);
});

withHost("the deadline is read again after the claim: crossing it in between still expires", async (h) => {
  const notAfter = new Date(Date.now() + 120_000);
  await h.request({ notAfter: notAfter.toISOString() });
  // First read just before the deadline, the read after the claim at it.
  await writeFile(join(h.fake, "clock"), `${notAfter.getTime() - 1}\n${notAfter.getTime()}\n`);
  const run = h.run();
  assert.deepEqual(h.states(run), ["queued", "expired"]);
  assert.equal((await h.result()).state, "expired");
  assert.deepEqual(await h.lines("docker.log"), [], "never started");
  await assertInvariants(h, run);
});

// ---------------------------------------------------------------- replay ----

withHost("a replayed request for a finished operation is removed and never applied again", async (h) => {
  await h.request();
  assert.equal(h.run().status, 0);
  const first = await readFile(join(h.spool, "results", `${OP}.json`), "utf8");
  await rm(join(h.fake, "docker.log"));
  await h.request();
  const run = h.run();
  assert.equal(run.status, 0);
  assert.match(run.stdout, /already succeeded; request removed/);
  assert.equal(await readFile(join(h.spool, "results", `${OP}.json`), "utf8"), first, "the result is not rewritten");
  assert.deepEqual(await h.lines("docker.log"), []);
  assert.deepEqual(await h.lines("ups"), [`up ${NEW_IMAGE}`]);
  assert.equal(await exists(h.requestPath()), false);
  await assertInvariants(h, run);
});

withHost("a claimed operation without a journal is closed, never started", async (h) => {
  await writeFile(
    join(h.spool, "results", `${OP}.json`),
    JSON.stringify({ operationId: OP, state: "picked_up", updatedAt: "2026-11-13T12:00:00Z" }),
  );
  await h.request();
  const run = h.run();
  const result = await h.result();
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "UPDATE_INTERRUPTED");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

// -------------------------------------------------------------- rollback ----

withHost("a candidate that never answers is rolled back, and the rollback is verified", async (h) => {
  await h.request();
  const run = h.run({ FAKE_BROKEN: NEW_HEX });
  assert.equal(run.status, 0, run.stderr);
  const result = await h.result();
  assert.equal(result.state, "rolled_back");
  assert.equal(result.errorCode, "HEALTH_AGENT_UNREACHABLE");
  assert.deepEqual(h.states(run).slice(-3), ["replacing", "health_check", "rolled_back"]);
  assert.deepEqual(await h.lines("ups"), [`up ${NEW_IMAGE}`, `up ${OLD_IMAGE}`]);
  assert.equal((await readFile(join(h.fake, "running"), "utf8")).trim(), OLD_IMAGE);
  assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`), "agent.env restored from the pin");
  assert.match(await h.pinFile(), new RegExp(`^BRIDGE_AGENT_IMAGE=${OLD_IMAGE}$`, "m"), "the pin never moved");
  // The rollback was verified independently: identity and status of the previous image.
  assert.equal((await h.lines("curl.log")).filter((l) => l.endsWith("/v1/status")).length, 1);
  assert.equal(await exists(h.journal), false);
  assert.equal(await exists(h.requestPath()), false);
  await assertInvariants(h, run);
});

for (const [name, extra, code] of [
  ["reports frps unreachable", { FAKE_FRPS_DOWN: NEW_HEX }, "HEALTH_FRPS_UNREACHABLE"],
  ["answers for another bridge", { FAKE_WRONG_IDENTITY: NEW_HEX }, "HEALTH_IDENTITY_MISMATCH"],
  ["lacks update.v1", { FAKE_NO_UPDATE_CAP: NEW_HEX }, "HEALTH_CAPABILITY_MISSING"],
  ["does not start", { FAKE_UP_FAILS: NEW_HEX }, "CANDIDATE_START_FAILED"],
]) {
  withHost(`a candidate that ${name} is rolled back (${code})`, async (h) => {
    await h.request();
    const run = h.run(extra);
    const result = await h.result();
    assert.equal(result.state, "rolled_back");
    assert.equal(result.errorCode, code);
    assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`));
    await assertInvariants(h, run);
  });
}

withHost("a rollback whose previous image fails its checks is reported as rollback_failed", async (h) => {
  await h.request();
  const run = h.run({ FAKE_BROKEN: `${NEW_HEX} ${OLD_HEX}` });
  const result = await h.result();
  assert.equal(result.state, "rollback_failed");
  assert.equal(result.errorCode, "ROLLBACK_VERIFICATION_FAILED");
  assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`), "the known-good image is still what compose runs");
  assert.match(await h.pinFile(), new RegExp(`^BRIDGE_AGENT_IMAGE=${OLD_IMAGE}$`, "m"));
  assert.equal(await exists(h.journal), false, "terminal: the operator takes over, the unit does not loop");
  await assertInvariants(h, run);
});

withHost("a rollback that cannot start the previous image is rollback_failed", async (h) => {
  await h.request();
  const run = h.run({ FAKE_UP_FAILS: `${NEW_HEX} ${OLD_HEX}` });
  const result = await h.result();
  assert.equal(result.state, "rollback_failed");
  assert.equal(result.errorCode, "ROLLBACK_START_FAILED");
  await assertInvariants(h, run);
});

withHost("a failed pull replaces nothing and is a plain failure", async (h) => {
  await h.request();
  const run = h.run({ FAKE_PULL_FAILS: "1" });
  const result = await h.result();
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "PULL_FAILED");
  assert.deepEqual(await h.lines("ups"), []);
  assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`));
  await assertInvariants(h, run);
});

withHost("an image for another platform is refused before replacement", async (h) => {
  await h.request();
  const run = h.run({ FAKE_PLATFORM: "linux/arm64" });
  assert.equal((await h.result()).errorCode, "IMAGE_PLATFORM_MISMATCH");
  assert.deepEqual(await h.lines("ups"), []);
  await assertInvariants(h, run);
});

// -------------------------------------------------------------- recovery ----

withHost("a run killed during the replacement is recovered on the next start without re-applying", async (h) => {
  await h.request();
  const child = spawn("bash", [scriptPath], { env: { ...h.env, FAKE_UP_SLEEP: "30" }, detached: true, stdio: "ignore" });
  for (let i = 0; i < 200 && !(await exists(join(h.fake, "marker"))); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(await exists(join(h.fake, "marker")), "the first run never reached the replacement");
  process.kill(-child.pid, "SIGKILL");
  await new Promise((resolve) => child.on("close", resolve));

  // What an interruption leaves: the journal, the candidate in agent.env, the request still in place.
  assert.match(await readFile(h.journal, "utf8"), /^PHASE=replacing$/m);
  assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${NEW_IMAGE}`));
  assert.equal(await exists(h.requestPath()), true, "the request keeps the path unit armed");
  assert.equal((await h.result()).state, "replacing");
  await rm(join(h.fake, "ups"));

  const run = h.run();
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /recovering an interrupted run \(phase replacing\)/);
  const result = await h.result();
  assert.equal(result.state, "rolled_back");
  assert.equal(result.errorCode, "UPDATE_INTERRUPTED");
  assert.deepEqual(await h.lines("ups"), [`up ${OLD_IMAGE}`], "the candidate is never started a second time");
  assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`));
  assert.equal(await exists(h.journal), false);
  assert.equal(await exists(h.requestPath()), false);
  await assertInvariants(h, run);
});

withHost("an interrupted health check whose candidate now passes is accepted, not replaced again", { envImage: NEW_IMAGE, running: NEW_IMAGE }, async (h) => {
  await writeFile(join(h.fake, "images"), `${OLD_IMAGE}\n${NEW_IMAGE}\n`);
  await h.writeJournal({ PHASE: "health_check" });
  await writeFile(join(h.stateDir, "image.pin.previous"), PIN(OLD_IMAGE));
  const run = h.run();
  assert.equal(run.status, 0, run.stderr);
  assert.equal((await h.result()).state, "succeeded");
  assert.deepEqual(await h.lines("ups"), []);
  assert.match(await h.pinFile(), new RegExp(`^BRIDGE_AGENT_IMAGE=${NEW_IMAGE}$`, "m"));
  assert.equal(await exists(h.journal), false);
  await assertInvariants(h, run);
});

withHost("an interrupted commit with a broken candidate restores the previous pin", { envImage: NEW_IMAGE, running: NEW_IMAGE, pin: PIN(NEW_IMAGE) }, async (h) => {
  await writeFile(join(h.fake, "images"), `${OLD_IMAGE}\n${NEW_IMAGE}\n`);
  await h.writeJournal({ PHASE: "committing" });
  await writeFile(join(h.stateDir, "image.pin.previous"), PIN(OLD_IMAGE));
  const run = h.run({ FAKE_BROKEN: NEW_HEX });
  assert.equal((await h.result()).state, "rolled_back");
  assert.match(await h.pinFile(), new RegExp(`^BRIDGE_AGENT_IMAGE=${OLD_IMAGE}$`, "m"));
  assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`));
  await assertInvariants(h, run);
});

withHost("an interruption before the replacement fails the operation and changes nothing", async (h) => {
  await h.writeJournal({ PHASE: "staging" });
  await h.request();
  const run = h.run();
  const result = await h.result();
  assert.equal(result.state, "failed");
  assert.equal(result.errorCode, "UPDATE_INTERRUPTED");
  assert.deepEqual(await h.lines("docker.log"), []);
  assert.ok((await h.agentEnv()).includes(`BRIDGE_AGENT_IMAGE=${OLD_IMAGE}`));
  assert.equal(await exists(h.requestPath()), false, "the request is not started afterwards either");
  await assertInvariants(h, run);
});

withHost("a journal left after a terminal result is only cleaned up", async (h) => {
  const finished = JSON.stringify({ operationId: OP, state: "succeeded", updatedAt: "2026-11-13T12:00:00Z" });
  await writeFile(join(h.spool, "results", `${OP}.json`), finished);
  await h.writeJournal({ PHASE: "committing" });
  const run = h.run();
  assert.match(run.stdout, /already succeeded; cleaning up/);
  assert.equal(await readFile(join(h.spool, "results", `${OP}.json`), "utf8"), finished);
  assert.equal(await exists(h.journal), false);
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

withHost("an unreadable journal is dropped without acting on it", async (h) => {
  await h.writeJournal({ OPERATION_ID: "../../etc", PHASE: "rolling_back" });
  const run = h.run();
  assert.equal(run.status, 0);
  assert.match(run.stdout, /journal is unreadable/);
  assert.equal(await exists(h.journal), false);
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});

// ------------------------------------------------------------ concurrency ----

withHost("concurrent runs are serialised; the busy run leaves the request for the path unit", async (h) => {
  await h.request();
  const first = spawn("bash", [scriptPath], { env: { ...h.env, FAKE_UP_SLEEP: "2" }, stdio: "ignore" });
  const firstDone = new Promise((resolve) => first.on("close", resolve));
  for (let i = 0; i < 200 && !(await exists(join(h.fake, "marker"))); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.ok(await exists(join(h.fake, "marker")));

  const second = h.run();
  assert.equal(second.status, 0);
  assert.match(second.stdout, /another run holds the lock/);
  assert.equal(await exists(h.requestPath()), true, "left in place: PathExistsGlob= retries it");

  assert.equal(await firstDone, 0);
  assert.equal((await h.result()).state, "succeeded");
  assert.deepEqual(await h.lines("ups"), [`up ${NEW_IMAGE}`], "applied once");
  await assertInvariants(h, second);
});

// -------------------------------------------------- unwritable results ----

const asNonRoot = { skip: !canExecute ? "needs Linux bash + flock" : process.getuid?.() === 0 ? "root ignores directory modes" : false };

test("without a written claim nothing starts and the request stays", asNonRoot, async () => {
  const h = await fixture();
  try {
    await h.request();
    await chmod(join(h.spool, "results"), 0o500);
    const run = h.run();
    await chmod(join(h.spool, "results"), 0o755);
    assert.notEqual(run.status, 0, "the unit sees the failure");
    assert.match(run.stdout, /the claim could not be written; not started/);
    assert.deepEqual(await h.lines("docker.log"), [], "never started");
    assert.equal(await exists(h.requestPath()), true, "the agent keeps judging it by its clock");
    assert.equal(await exists(h.journal), false);
    assert.deepEqual(await readdir(join(h.spool, "results")), []);
    await assertInvariants(h, run);
  } finally {
    await chmod(join(h.spool, "results"), 0o755).catch(() => {});
    await h.cleanup();
  }
});

test("a terminal result that cannot be written keeps the journal and the request; the next run finishes", asNonRoot, async () => {
  const h = await fixture();
  try {
    await h.request();
    const results = join(h.spool, "results");
    const first = h.run({ FAKE_LOCK_DIR_ON_UP: results });
    await chmod(results, 0o755);
    assert.notEqual(first.status, 0);
    assert.match(first.stdout, /cannot record succeeded; keeping the journal and the request/);
    assert.equal(await exists(h.journal), true);
    assert.equal(await exists(h.requestPath()), true);
    assert.notEqual((await h.result()).state, "succeeded", "never reported before it is recorded");

    const second = h.run();
    assert.equal(second.status, 0, second.stderr);
    assert.match(second.stdout, /recovering an interrupted run \(phase committing\)/);
    assert.equal((await h.result()).state, "succeeded");
    assert.deepEqual(await h.lines("ups"), [`up ${NEW_IMAGE}`], "the candidate is started once");
    assert.equal(await exists(h.journal), false);
    assert.equal(await exists(h.requestPath()), false);
    await assertInvariants(h, second);
  } finally {
    await chmod(join(h.spool, "results"), 0o755).catch(() => {});
    await h.cleanup();
  }
});

withHost("an unreadable clock never starts an operation", async (h) => {
  await h.request();
  await writeFile(join(h.fake, "clock"), "not-a-number\n");
  const run = h.run();
  assert.equal((await h.result()).state, "expired");
  assert.deepEqual(await h.lines("docker.log"), []);
  await assertInvariants(h, run);
});
