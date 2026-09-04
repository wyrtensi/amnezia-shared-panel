import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptUrl = new URL("../scripts/capacity-apply.sh", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);

// Same guard as agent-update.test.mjs: the executing tests need bash, flock
// (util-linux) and /proc. They skip on the Windows dev box and run in the
// `infra` CI job.
const canExecute =
  process.platform === "linux" && spawnSync("flock", ["--version"]).status === 0;
const executing = { skip: canExecute ? false : "needs Linux bash + flock" };

const NODE_ENV_FILE = (peers) =>
  [
    "# a comment the rewrite must keep",
    "NODE_AGENT_IMAGE=ghcr.io/owner/repo/node-agent@sha256:aaa",
    "DOCKER_GID=999",
    `SERVER_MAX_PEERS=${peers}`,
    "",
  ].join("\n");

/**
 * A throwaway node directory, spool and lock dir, plus a fake set-capacity.sh.
 *
 * The fake records its arguments and, unless told to fail, rewrites .env the way
 * the real script does. That is the seam worth faking: the real one recreates a
 * container and waits on a health gate, and this script's whole job is to hand
 * it a validated number and report what came back.
 */
const fixture = async ({ peers = 250, applyFails = false } = {}) => {
  const root = await mkdtemp(join(tmpdir(), "node-capacity-"));
  const nodeDir = join(root, "node");
  const scripts = join(nodeDir, "scripts");
  const spool = join(root, "spool");
  const lockDir = join(root, "lock");
  await mkdir(scripts, { recursive: true });
  await mkdir(spool, { recursive: true });
  await writeFile(join(nodeDir, ".env"), NODE_ENV_FILE(peers), { mode: 0o600 });
  await writeFile(join(nodeDir, "compose.yaml"), "services:\n  node-agent: {}\n");

  const setCapacity = `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$APPLY_LOG"
[ -z "\${FAKE_APPLY_FAILS:-}" ] || { echo "preflight refused" >&2; exit 1; }
sed -i "s/^SERVER_MAX_PEERS=.*/SERVER_MAX_PEERS=$1/" "$PWD/.env"
exit 0
`;
  await writeFile(join(scripts, "set-capacity.sh"), setCapacity, { mode: 0o755 });
  await chmod(join(scripts, "set-capacity.sh"), 0o755);

  const env = {
    ...process.env,
    AMNEZIA_NODE_DIR: nodeDir,
    NODE_CAPACITY_SPOOL_DIR: spool,
    NODE_CAPACITY_LOCK_DIR: lockDir,
    APPLY_LOG: join(root, "apply-calls.log"),
  };
  if (applyFails) env.FAKE_APPLY_FAILS = "1";

  const request = (body) =>
    writeFile(join(spool, "request.json"), `${JSON.stringify(body)}\n`);
  const run = (extra = {}) =>
    spawnSync("bash", [scriptPath], { env: { ...env, ...extra }, encoding: "utf8" });
  const applyCalls = async () =>
    (await readFile(env.APPLY_LOG, "utf8").catch(() => ""))
      .split("\n")
      .filter(Boolean);
  const result = async () =>
    JSON.parse(await readFile(join(spool, "result.json"), "utf8"));
  const envFile = () => readFile(join(nodeDir, ".env"), "utf8");

  return {
    root,
    nodeDir,
    spool,
    env,
    request,
    run,
    applyCalls,
    result,
    envFile,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

// ---------------------------------------------------------------- static ----
// These run on every platform, including the Windows dev box, because they are
// the security properties ported from agent-update.sh and must not drift.

test("the lock lives outside the container-writable spool", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.doesNotMatch(script, /exec 9>/, "the lock must not be opened for writing");
  assert.doesNotMatch(
    script,
    /SPOOL_DIR}\/\.lock/,
    "the lock must not be a spool path: the agent can swap anything there for a symlink",
  );
  assert.match(script, /NODE_CAPACITY_LOCK_DIR:-\/run\/amnezia-node-capacity/);
  assert.match(script, /exec 9<"\$LOCK_DIR"/);
  assert.match(
    script,
    /chmod 0700 "\$LOCK_DIR"/,
    "the lock dir is tightened even if it pre-existed",
  );
});

test("the request is verified through /proc, not through a path test", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /exec 8<"\$REQUEST"/);
  assert.match(script, /readlink -- "\/proc\/\$\$\/fd\/8"/);
  assert.doesNotMatch(
    script,
    /\[ -L "\$REQUEST" \]/,
    "a -L test leaves a window between the test and the open",
  );
});

test("the result is written to a fresh mktemp file and renamed", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /mktemp "\$\{SPOOL_DIR\}\/result\.XXXXXX"/);
  assert.match(script, /mv -f "\$tmp" "\$RESULT"/);
  assert.doesNotMatch(
    script,
    />"\$RESULT"/,
    "writing through the target as root follows a planted symlink",
  );
});

test("--force is never passed on, so a button cannot reach an unvalidated capacity", async () => {
  const script = await readFile(scriptUrl, "utf8");
  // The invocation itself, not the file: the comments explain --force on
  // purpose, and asserting on the whole text would fail on the explanation.
  const invocation = script.match(/sh scripts\/set-capacity\.sh[^\n]*/)?.[0];

  assert.ok(invocation, "the script must actually call set-capacity.sh");
  assert.doesNotMatch(invocation, /--force/);
  assert.match(script, /^MAX_PEERS=500$/m);
});

// ------------------------------------------------------------- executing ----

test("applies a valid request and reports the number it applied", executing, async () => {
  const f = await fixture({ peers: 250 });
  try {
    await f.request({ id: "req-1", maxPeers: 300 });
    const run = f.run();

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(await f.applyCalls(), ["300"]);
    assert.match(await f.envFile(), /^SERVER_MAX_PEERS=300$/m);
    const result = await f.result();
    assert.equal(result.ok, true);
    assert.equal(result.id, "req-1");
    assert.equal(result.maxPeers, 300);
  } finally {
    await f.cleanup();
  }
});

test("does nothing when the node already runs that number", executing, async () => {
  const f = await fixture({ peers: 300 });
  try {
    await f.request({ id: "req-2", maxPeers: 300 });
    const run = f.run();

    assert.equal(run.status, 0, run.stderr);
    assert.deepEqual(await f.applyCalls(), [], "the container must not be recreated for nothing");
    assert.equal((await f.result()).ok, true);
  } finally {
    await f.cleanup();
  }
});

test("reports a refusal from set-capacity.sh instead of claiming success", executing, async () => {
  const f = await fixture({ peers: 250, applyFails: true });
  try {
    await f.request({ id: "req-3", maxPeers: 400 });
    const run = f.run();

    assert.equal(run.status, 1);
    const result = await f.result();
    assert.equal(result.ok, false);
    assert.match(result.message, /refused or failed/);
    assert.match(await f.envFile(), /^SERVER_MAX_PEERS=250$/m, "the old value stands");
  } finally {
    await f.cleanup();
  }
});

// The number is validated by the agent, by this script and by set-capacity.sh.
// That is layering across three threat models, not duplication: the spool is a
// file on disk that a container can write.
test("refuses a capacity above the validated ceiling", executing, async () => {
  const f = await fixture();
  try {
    await f.request({ id: "req-4", maxPeers: 900 });
    const run = f.run();

    assert.equal(run.status, 1);
    assert.deepEqual(await f.applyCalls(), []);
    assert.match((await f.result()).message, /above the validated limit/);
  } finally {
    await f.cleanup();
  }
});

test("refuses a missing or non-numeric capacity", executing, async () => {
  const f = await fixture();
  try {
    await f.request({ id: "req-5", maxPeers: "300; rm -rf /" });
    const run = f.run();

    assert.equal(run.status, 1);
    assert.deepEqual(await f.applyCalls(), []);
    assert.match((await f.result()).message, /not a whole number/);
  } finally {
    await f.cleanup();
  }
});

test("refuses a request file that is a symlink, and says so", executing, async () => {
  const f = await fixture();
  try {
    const target = join(f.root, "elsewhere.json");
    await writeFile(target, JSON.stringify({ id: "req-6", maxPeers: 400 }));
    await symlink(target, join(f.spool, "request.json"));

    const run = f.run();

    assert.equal(run.status, 1);
    assert.deepEqual(await f.applyCalls(), []);
    // The request is consumed and nothing retries it, so the panel must be told
    // rather than left looking at a stale result.
    assert.match((await f.result()).message, /not a regular spool file/);
  } finally {
    await f.cleanup();
  }
});

test("consumes the request even when it fails, so the path unit cannot loop", executing, async () => {
  const f = await fixture({ applyFails: true });
  try {
    await f.request({ id: "req-7", maxPeers: 400 });
    f.run();

    await assert.rejects(readFile(join(f.spool, "request.json"), "utf8"));
  } finally {
    await f.cleanup();
  }
});

test("does nothing at all when there is no request", executing, async () => {
  const f = await fixture();
  try {
    const run = f.run();

    assert.equal(run.status, 0);
    assert.deepEqual(await f.applyCalls(), []);
    await assert.rejects(readFile(join(f.spool, "result.json"), "utf8"));
  } finally {
    await f.cleanup();
  }
});
