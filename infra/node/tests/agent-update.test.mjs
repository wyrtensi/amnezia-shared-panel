import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import {
  chmod,
  lstat,
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

const scriptUrl = new URL("../scripts/agent-update.sh", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);

// Same guard as infra/prod/tests/panel-updater.test.mjs: the executing tests
// need bash, flock (util-linux) and /proc. They skip on the Windows dev box and
// run in the `infra` CI job.
const canExecute =
  process.platform === "linux" && spawnSync("flock", ["--version"]).status === 0;
const executing = { skip: canExecute ? false : "needs Linux bash + flock" };

const exists = (path) => lstat(path).then(() => true, () => false);

const REPO = "ghcr.io/owner/repo/node-agent";
const OLD_DIGEST = `sha256:${"1".repeat(64)}`;
const NEW_DIGEST = `sha256:${"2".repeat(64)}`;
const OLD_IMAGE = `${REPO}@${OLD_DIGEST}`;
const NEW_IMAGE = `${REPO}@${NEW_DIGEST}`;

const NODE_ENV_FILE = (image) =>
  [
    "# a comment the rewrite must keep",
    `NODE_AGENT_IMAGE=${image}`,
    "DOCKER_GID=999",
    "SERVER_MAX_PEERS=250",
    "",
  ].join("\n");

const COMPOSE_V1 = "services:\n  node-agent:\n    image: ${NODE_AGENT_IMAGE}\n";
const COMPOSE_V2 =
  "services:\n  node-agent:\n    image: ${NODE_AGENT_IMAGE}\n    environment:\n      NEW_KEY: 1\n";

/**
 * A throwaway node directory, spool, lock dir and a fake `docker` on PATH.
 *
 * The fake records every invocation in $DOCKER_LOG and answers the handful of
 * queries the updater makes. `images/<digest hex>/compose.yaml` in the fixture
 * stands for the deployment files an image ships; a missing directory stands
 * for an image built before those files were added, which the updater must
 * still be able to install.
 */
const fixture = async ({
  envImage = OLD_IMAGE,
  compose = COMPOSE_V1,
  health = "healthy",
  pullFails = false,
  shipped = {},
} = {}) => {
  const root = await mkdtemp(join(tmpdir(), "node-agent-update-"));
  const nodeDir = join(root, "node");
  const spool = join(root, "spool");
  const lockDir = join(root, "lock");
  const bin = join(root, "bin");
  const images = join(root, "images");
  await mkdir(nodeDir, { recursive: true });
  await mkdir(spool, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(nodeDir, ".env"), NODE_ENV_FILE(envImage), { mode: 0o600 });
  await writeFile(join(nodeDir, "compose.yaml"), compose);

  for (const [digest, files] of Object.entries(shipped)) {
    const dir = join(images, digest.replace("sha256:", ""));
    await mkdir(dir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      await writeFile(join(dir, name), content);
    }
  }

  const docker = `#!/usr/bin/env bash
# Fake docker for the updater tests. Records the call, then answers.
printf '%s\\n' "$*" >>"$DOCKER_LOG"
case "$1 $2" in
  "pull "*)
    [ -z "\${FAKE_PULL_FAILS:-}" ] || { echo "pull refused" >&2; exit 1; }
    exit 0 ;;
esac
case "$1" in
  image)
    # image inspect --format '{{.Os}}' / '{{.Architecture}}'
    case "$*" in
      *Os*) echo linux ;;
      *Architecture*) echo amd64 ;;
      *) echo "" ;;
    esac
    exit 0 ;;
  create)
    # create --name <name> <image>
    echo "$4" >"$FAKE_STATE/container-$3"
    echo "$3"
    exit 0 ;;
  cp)
    # cp <name>:<path> <dest>
    src="\${2%%:*}"; path="\${2#*:}"
    image="$(cat "$FAKE_STATE/container-$src" 2>/dev/null || true)"
    hex="\${image##*sha256:}"
    file="$FAKE_IMAGES/$hex/$(basename "$path")"
    [ -f "$file" ] || { echo "no such file in image" >&2; exit 1; }
    cp "$file" "$3"
    exit 0 ;;
  rm) exit 0 ;;
  inspect)
    # inspect --format '{{...Health...}}' amnezia-node-agent
    echo "\${FAKE_HEALTH:-healthy}"
    exit 0 ;;
  compose)
    [ -z "\${FAKE_COMPOSE_FAILS:-}" ] || exit 1
    exit 0 ;;
esac
exit 0
`;
  await writeFile(join(bin, "docker"), docker, { mode: 0o755 });
  await chmod(join(bin, "docker"), 0o755);

  const fakeState = join(root, "fake-state");
  await mkdir(fakeState, { recursive: true });

  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    AMNEZIA_NODE_DIR: nodeDir,
    NODE_UPDATE_SPOOL_DIR: spool,
    NODE_UPDATER_LOCK_DIR: lockDir,
    NODE_AGENT_UPDATE_REPO: REPO,
    DOCKER_LOG: join(root, "docker.log"),
    FAKE_STATE: fakeState,
    FAKE_IMAGES: images,
    FAKE_HEALTH: health,
    MARKER: join(root, "marker"),
  };
  if (pullFails) env.FAKE_PULL_FAILS = "1";

  const request = (body) => writeFile(join(spool, "request.json"), `${JSON.stringify(body)}\n`);
  const run = (extra = {}) =>
    spawnSync("bash", [scriptPath], { env: { ...env, ...extra }, encoding: "utf8" });
  const dockerCalls = async () =>
    (await readFile(env.DOCKER_LOG, "utf8").catch(() => "")).split("\n").filter(Boolean);
  const result = async () => JSON.parse(await readFile(join(spool, "result.json"), "utf8"));
  const envFile = () => readFile(join(nodeDir, ".env"), "utf8");
  const composeFile = () => readFile(join(nodeDir, "compose.yaml"), "utf8");

  return {
    root,
    nodeDir,
    spool,
    lockDir,
    env,
    request,
    run,
    dockerCalls,
    result,
    envFile,
    composeFile,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

// ---------------------------------------------------------------- static ----
// These run on every platform, including the Windows dev box, because they are
// the properties that were ported from panel-updater.sh and must not drift.

test("the lock lives outside the container-writable spool", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.doesNotMatch(script, /exec 9>/, "the lock must not be opened for writing");
  assert.doesNotMatch(
    script,
    /SPOOL_DIR}\/\.lock/,
    "the lock must not be a spool path: the agent can swap anything there for a symlink",
  );
  assert.match(script, /NODE_UPDATER_LOCK_DIR:-\/run\/amnezia-node/);
  assert.match(script, /exec 9<"\$LOCK_DIR"/);
  assert.match(script, /chmod 0700 "\$LOCK_DIR"/, "the lock dir is tightened even if it pre-existed");
});

test("the request is verified through /proc after being opened once", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /exec 8<"\$REQUEST"/);
  assert.match(script, /\/proc\/\$\$\/fd\/8/, "the descriptor, not the path, is what gets checked");
});

test("the agent-only update never reaches for the AWG containers", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /--no-deps/);
  // node-agent declares depends_on: awg2, awg3. A `compose up` without
  // --no-deps therefore recreates both and drops every live tunnel, which is
  // the one thing this feature exists not to do.
  assert.doesNotMatch(
    script,
    /compose[^\n]*\bup\b(?![^\n]*--no-deps)/,
    "every compose up in this script must carry --no-deps",
  );
});

test("the .env rewrite is atomic and keeps the file private", async () => {
  const script = await readFile(scriptUrl, "utf8");

  // A truncated .env fails ${NODE_AGENT_IMAGE:?} in compose and takes the node
  // down at the next deploy, which is worse than a failed update.
  assert.match(script, /mv -f "\$env_tmp" "\$ENV_FILE"/);
  // `mv -f` carries the temp file's mode onto the target, so the mode has to be
  // set here - the same way a state file lost its 0600 in services/node-agent.
  assert.match(script, /chmod 600 "\$env_tmp"/);
});

test("the reference is re-validated from the spool, not trusted", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.match(script, /NODE_AGENT_UPDATE_REPO/);
  assert.match(script, /sha256:\[0-9a-f\]\{64\}/, "only a full lowercase digest is accepted");
});

// ------------------------------------------------------------- executing ----

test("a symlinked request.json is refused before it is read", executing, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  const secret = join(f.root, "secret.json");
  await writeFile(secret, `{"id":"stolen","image":"${NEW_IMAGE}"}\n`);
  await symlink(secret, join(f.spool, "request.json"));

  const run = f.run();

  assert.equal(run.status, 1);
  assert.match(run.stderr, /refusing/);
  const refusal = await f.result();
  assert.equal(refusal.ok, false);
  assert.equal(refusal.id, "unknown", "the id is never parsed from a refused request");
  assert.doesNotMatch(refusal.message, /stolen/, "the target content must not reach the result");
  assert.equal(await exists(join(f.spool, "request.json")), false);
  assert.deepEqual(await f.dockerCalls(), [], "nothing is pulled or started for a refused request");
});

test("an image outside the configured repository is refused", executing, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.request({ id: "req-evil", image: `ghcr.io/evil/repo/node-agent@${NEW_DIGEST}` });

  const run = f.run();

  assert.notEqual(run.status, 0);
  const refusal = await f.result();
  assert.equal(refusal.ok, false);
  assert.equal(refusal.id, "req-evil");
  assert.match(refusal.message, /repository|reference/i);
  assert.deepEqual(await f.dockerCalls(), [], "a refused reference is never pulled");
  assert.ok((await f.envFile()).includes(`NODE_AGENT_IMAGE=${OLD_IMAGE}`));
});

test("a mutable tag is refused even inside the configured repository", executing, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.request({ id: "req-tag", image: `${REPO}:1.1.2` });

  const run = f.run();

  assert.notEqual(run.status, 0);
  assert.equal((await f.result()).ok, false);
  assert.deepEqual(await f.dockerCalls(), []);
});

test("the request is a no-op when the node already runs that digest", executing, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.request({ id: "req-same", image: OLD_IMAGE });

  const run = f.run();

  assert.equal(run.status, 0, run.stderr);
  const result = await f.result();
  assert.equal(result.ok, true);
  assert.equal(result.id, "req-same");
  assert.match(result.message, /already/i);
  // A re-sent request must not restart a healthy agent.
  assert.equal(
    (await f.dockerCalls()).some((call) => call.startsWith("compose")),
    false,
    "an already-current node is not recreated",
  );
});

test("the happy path pulls, rewrites .env and recreates only the agent", executing, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.request({ id: "req-ok", image: NEW_IMAGE });

  const run = f.run();

  assert.equal(run.status, 0, run.stderr + run.stdout);
  const result = await f.result();
  assert.equal(result.ok, true);
  assert.equal(result.image, NEW_IMAGE);

  const calls = await f.dockerCalls();
  assert.ok(calls.some((c) => c.startsWith(`pull --platform linux/amd64 ${NEW_IMAGE}`)), calls.join("\n"));
  const up = calls.find((c) => c.includes(" up "));
  assert.ok(up, "the agent is recreated");
  assert.match(up, /--no-deps/);
  assert.match(up, /node-agent$/, "exactly one service is named");

  const envText = await f.envFile();
  assert.ok(envText.split("\n").includes(`NODE_AGENT_IMAGE=${NEW_IMAGE}`), "the digest line is rewritten whole");
  assert.doesNotMatch(envText, /sha256:1{64}/, "the old digest is gone");
  assert.match(envText, /# a comment the rewrite must keep/);
  assert.match(envText, /SERVER_MAX_PEERS=250/, "the rest of .env survives");
  assert.equal((await lstat(join(f.nodeDir, ".env"))).mode & 0o777, 0o600);

  assert.equal(await exists(join(f.spool, "update.log")), true, "the log the panel reads is written");
});

test("a failed health gate rolls .env back and restarts the old agent", executing, async (t) => {
  const f = await fixture({ health: "unhealthy" });
  t.after(f.cleanup);
  await f.request({ id: "req-bad", image: NEW_IMAGE });

  const run = f.run();

  assert.notEqual(run.status, 0);
  const result = await f.result();
  assert.equal(result.ok, false);
  assert.match(result.message, /health|rolled back/i);

  // A node whose agent will not start has lost its management path entirely,
  // and the panel is the tool you would use to notice.
  assert.ok((await f.envFile()).includes(`NODE_AGENT_IMAGE=${OLD_IMAGE}`));
  const ups = (await f.dockerCalls()).filter((c) => c.includes(" up "));
  assert.equal(ups.length, 2, "the old agent is brought back");
  assert.match(ups[1], /--no-deps/);
});

test("a failed pull changes nothing on the node", executing, async (t) => {
  const f = await fixture({ pullFails: true });
  t.after(f.cleanup);
  await f.request({ id: "req-pull", image: NEW_IMAGE });

  const run = f.run();

  assert.notEqual(run.status, 0);
  assert.equal((await f.result()).ok, false);
  assert.ok((await f.envFile()).includes(`NODE_AGENT_IMAGE=${OLD_IMAGE}`));
  assert.equal((await f.dockerCalls()).some((c) => c.includes(" up ")), false);
});

test("concurrent runs are serialised and the second request is left queued", executing, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.request({ id: "first", image: NEW_IMAGE });

  // Make the first run hang inside `docker compose up` so the lock is held.
  const slowDocker = { ...f.env, FAKE_SLEEP: "3" };
  await writeFile(
    join(f.root, "bin", "docker"),
    `#!/usr/bin/env bash
printf '%s\\n' "$*" >>"$DOCKER_LOG"
if [ "$1" = compose ]; then echo started >"$MARKER"; sleep "\${FAKE_SLEEP:-0}"; exit 0; fi
case "$1" in
  image) case "$*" in *Os*) echo linux ;; *Architecture*) echo amd64 ;; esac ;;
  inspect) echo "\${FAKE_HEALTH:-healthy}" ;;
  cp) exit 1 ;;
  create) echo "$3" ;;
esac
exit 0
`,
    { mode: 0o755 },
  );

  const first = spawn("bash", [scriptPath], { env: slowDocker });
  const firstDone = new Promise((resolve) => first.on("close", resolve));
  for (let i = 0; i < 100 && !(await exists(f.env.MARKER)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(await exists(f.env.MARKER), "the first run never reached compose");

  await f.request({ id: "second", image: NEW_IMAGE });
  const second = f.run();

  assert.equal(second.status, 0);
  assert.match(second.stdout, /another run holds the lock/);
  // PathExists= is level-triggered, so leaving the file is what retries it.
  assert.equal(await exists(join(f.spool, "request.json")), true);
  assert.equal(await firstDone, 0);
  assert.equal((await f.result()).id, "first");
});

// --------------------------------------------------- compose reconciliation --

test("an image that ships no compose still installs (the image-only path)", executing, async (t) => {
  const f = await fixture();
  t.after(f.cleanup);
  await f.request({ id: "req-nofiles", image: NEW_IMAGE });

  const run = f.run();

  assert.equal(run.status, 0, run.stderr);
  assert.equal((await f.result()).ok, true);
  assert.equal(await f.composeFile(), COMPOSE_V1, "nothing to reconcile, nothing changed");
});

test("a new compose the running image cannot vouch for is reported, not blocked", executing, async (t) => {
  // Every node in the fleet runs an image built before deployment files were
  // shipped, so its compose.yaml has no provenance. Refusing here would make the
  // first update impossible on exactly the nodes that need it.
  const f = await fixture({
    compose: COMPOSE_V1,
    shipped: { [NEW_DIGEST]: { "compose.yaml": COMPOSE_V2 } },
  });
  t.after(f.cleanup);
  await f.request({ id: "req-unknown", image: NEW_IMAGE });

  const run = f.run();

  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal((await f.result()).ok, true);
  assert.equal(await f.composeFile(), COMPOSE_V1, "an unvouched file is never overwritten");
  const log = await readFile(join(f.spool, "update.log"), "utf8");
  assert.match(log, /cannot be shown to be unmodified/);
  assert.match(log, /NEW_KEY/, "the operator is shown what to reconcile by hand");
});

test("an unchanged node compose is upgraded to the one the new image ships", executing, async (t) => {
  const f = await fixture({
    compose: COMPOSE_V1,
    shipped: {
      [OLD_DIGEST]: { "compose.yaml": COMPOSE_V1 },
      [NEW_DIGEST]: { "compose.yaml": COMPOSE_V2 },
    },
  });
  t.after(f.cleanup);
  await f.request({ id: "req-compose", image: NEW_IMAGE });

  const run = f.run();

  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal((await f.result()).ok, true);
  assert.equal(await f.composeFile(), COMPOSE_V2, "the node's file was provably untouched, so it is upgraded");
});

test("new .env keys the compose reads are reported, never invented", executing, async (t) => {
  const composeWithOption = [
    "services:",
    "  node-agent:",
    "    environment:",
    "      NEW_OPTION: ${NEW_OPTION:-a-default}",
    "",
  ].join("\n");
  const f = await fixture({
    compose: COMPOSE_V1,
    shipped: {
      [OLD_DIGEST]: { "compose.yaml": COMPOSE_V1 },
      [NEW_DIGEST]: { "compose.yaml": composeWithOption },
    },
  });
  t.after(f.cleanup);
  await f.request({ id: "req-keys", image: NEW_IMAGE });

  const run = f.run();

  assert.equal(run.status, 0, run.stderr + run.stdout);
  assert.equal((await f.result()).ok, true);
  const log = await readFile(join(f.spool, "update.log"), "utf8");
  assert.match(log, /NEW_OPTION/, "an operator who never hears about a key cannot set it");
  // A ${KEY:-default} is not a failure and the updater has no site-specific
  // value to put there, so it reports and moves on.
  assert.doesNotMatch(await f.envFile(), /NEW_OPTION/);
});

test("a required .env key the new compose adds stops the update", executing, async (t) => {
  const composeWithRequired =
    [
      "services:",
      "  node-agent:",
      "    environment:",
      "      MUST_SET: ${MUST_SET:?MUST_SET is required}",
      "",
    ].join("\n");
  const f = await fixture({
    compose: COMPOSE_V1,
    shipped: {
      [OLD_DIGEST]: { "compose.yaml": COMPOSE_V1 },
      [NEW_DIGEST]: { "compose.yaml": composeWithRequired },
    },
  });
  t.after(f.cleanup);
  await f.request({ id: "req-required", image: NEW_IMAGE });

  const run = f.run();

  assert.notEqual(run.status, 0);
  const result = await f.result();
  assert.equal(result.ok, false);
  assert.match(result.message, /MUST_SET/);
  // Starting a container that compose itself declares under-configured would
  // fail at once and cost the node its agent for the round trip.
  assert.equal((await f.dockerCalls()).some((c) => c.includes(" up ")), false);
  assert.ok((await f.envFile()).includes(`NODE_AGENT_IMAGE=${OLD_IMAGE}`));
});

test("a locally edited node compose stops the update and reports it", executing, async (t) => {
  const edited = `${COMPOSE_V1}    # this node runs on a shared host\n`;
  const f = await fixture({
    compose: edited,
    shipped: {
      [OLD_DIGEST]: { "compose.yaml": COMPOSE_V1 },
      [NEW_DIGEST]: { "compose.yaml": COMPOSE_V2 },
    },
  });
  t.after(f.cleanup);
  await f.request({ id: "req-edited", image: NEW_IMAGE });

  const run = f.run();

  assert.notEqual(run.status, 0);
  const result = await f.result();
  assert.equal(result.ok, false);
  assert.match(result.message, /compose/i);
  // Never merge, never overwrite: a node's compose may carry deliberate local
  // changes and silently replacing it is how a node loses its configuration.
  assert.equal(await f.composeFile(), edited);
  assert.ok((await f.envFile()).includes(`NODE_AGENT_IMAGE=${OLD_IMAGE}`));
  assert.equal((await f.dockerCalls()).some((c) => c.includes(" up ")), false);
  const log = await readFile(join(f.spool, "update.log"), "utf8");
  assert.match(log, /shared host/, "the log the panel shows carries the diff");
});
