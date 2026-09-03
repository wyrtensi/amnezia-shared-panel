import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptUrl = new URL("../panel-updater.sh", import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);

// The executing tests need bash, flock (util-linux) and /proc — i.e. Linux.
// They skip on the Windows dev box and run in the `infra` CI job.
const canExecute =
  process.platform === "linux" && spawnSync("flock", ["--version"]).status === 0;
const executing = { skip: canExecute ? false : "needs Linux bash + flock" };

const exists = (path) => lstat(path).then(() => true, () => false);

/**
 * A throwaway repo + spool + lock dir. `updateScript` replaces update.sh so the
 * test never touches docker.
 */
const fixture = async (updateScript) => {
  const root = await mkdtemp(join(tmpdir(), "panel-updater-"));
  const repo = join(root, "repo");
  const spool = join(root, "spool");
  const lockDir = join(root, "lock");
  await mkdir(join(repo, "infra", "prod"), { recursive: true });
  await mkdir(spool, { recursive: true });
  await writeFile(join(repo, "infra", "prod", "update.sh"), updateScript, { mode: 0o755 });
  const env = {
    ...process.env,
    PANEL_REPO_DIR: repo,
    UPDATE_SPOOL_HOST_DIR: spool,
    PANEL_UPDATER_LOCK_DIR: lockDir,
    MARKER: join(root, "marker"),
  };
  const run = () => spawnSync("bash", [scriptPath], { env, encoding: "utf8" });
  return { root, spool, lockDir, env, run, cleanup: () => rm(root, { recursive: true, force: true }) };
};

test("the lock never lives in the container-writable spool", async () => {
  const script = await readFile(scriptUrl, "utf8");

  assert.doesNotMatch(script, /exec 9>/, "the lock must not be opened for writing");
  assert.doesNotMatch(script, /SPOOL_DIR}\/\.lock/, "the lock must not be a spool path");
  assert.match(script, /PANEL_UPDATER_LOCK_DIR:-\/run\/amnezia-panel/);
  assert.match(script, /exec 9<"\$LOCK_DIR"/);
  assert.match(script, /chmod 0700 "\$LOCK_DIR"/, "the lock dir must be tightened even if it pre-existed");
});

test("a symlink planted at the old lock path is left untouched", executing, async (t) => {
  const f = await fixture("#!/usr/bin/env bash\necho updated\n");
  t.after(f.cleanup);
  const victim = join(f.root, "victim.txt");
  await writeFile(victim, "keep me\n");
  await symlink(victim, join(f.spool, ".lock"));
  await writeFile(join(f.spool, "request.json"), '{"id":"req-1","requestedAt":"x","requestedBy":"y"}\n');

  const result = f.run();

  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(victim, "utf8"), "keep me\n", "the symlink target must not be truncated");
  assert.ok((await lstat(join(f.spool, ".lock"))).isSymbolicLink(), "the planted link must still be a link");
  const written = JSON.parse(await readFile(join(f.spool, "result.json"), "utf8"));
  assert.equal(written.id, "req-1");
  assert.equal(written.ok, true);
  assert.equal(await exists(join(f.spool, "request.json")), false, "the request is consumed");
});

test("a symlinked request.json is refused before it is read", executing, async (t) => {
  const f = await fixture("#!/usr/bin/env bash\necho updated\n");
  t.after(f.cleanup);
  const secret = join(f.root, "secret.json");
  await writeFile(secret, '{"id":"stolen"}\n');
  await symlink(secret, join(f.spool, "request.json"));

  const result = f.run();

  assert.equal(result.status, 1);
  assert.match(result.stderr, /refusing/);
  assert.equal(await exists(join(f.spool, "result.json")), false, "nothing is written for a refused request");
  assert.equal(await exists(join(f.spool, "request.json")), false, "the link is removed so the path unit stops re-firing");
  assert.doesNotMatch(result.stdout + result.stderr, /stolen/, "the target content must never be read");
});

test("concurrent runs are serialised", executing, async (t) => {
  const f = await fixture('#!/usr/bin/env bash\necho started > "$MARKER"\nsleep 3\necho updated\n');
  t.after(f.cleanup);
  await writeFile(join(f.spool, "request.json"), '{"id":"first"}\n');

  const first = spawn("bash", [scriptPath], { env: f.env });
  const firstDone = new Promise((resolve) => first.on("close", resolve));
  // Wait until update.sh is actually running (the lock is held by then).
  for (let i = 0; i < 100 && !(await exists(f.env.MARKER)); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  assert.ok(await exists(f.env.MARKER), "first run did not start update.sh");

  await writeFile(join(f.spool, "request.json"), '{"id":"second"}\n');
  const second = f.run();

  assert.equal(second.status, 0);
  assert.match(second.stdout, /another run holds the lock/);
  assert.equal(await exists(join(f.spool, "request.json")), true, "the second request is left for the next path-unit fire");

  assert.equal(await firstDone, 0);
  const written = JSON.parse(await readFile(join(f.spool, "result.json"), "utf8"));
  assert.equal(written.id, "first");
  assert.equal(written.ok, true);
});
