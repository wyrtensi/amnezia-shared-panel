import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

// A file URL pathname is "/C:/..." on Windows; bash needs "C:/...". Git Bash
// accepts that form directly, so normalise once, here (same trick as
// ensure-swap.test.mjs and add-node.test.mjs).
const scriptFile = (rel) =>
  new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const bashPath = (value) => value.replace(/\\/g, "/");

const libPath = scriptFile("../lib/compose-dir.sh");
const backupScriptPath = scriptFile("../backup-db.sh");
const restoreScriptPath = scriptFile("../restore-db.sh");
const deployScriptPath = scriptFile("../deploy.sh");

// One fixture host: a bare directory tree with infra/prod and infra/dev, each
// optionally carrying the gitignored .env that marks a stack as actually
// configured, and each optionally carrying compose.yaml (always true on a
// real checkout, since that file is committed -- the "missing" case only
// exercises the final sanity check, not a realistic host).
const fixture = async ({
  prodEnv = false,
  devEnv = false,
  prodCompose = true,
  devCompose = true,
} = {}) => {
  const dir = bashPath(await mkdtemp(path.join(tmpdir(), "compose-dir-")));
  await mkdir(path.join(dir, "infra", "prod"), { recursive: true });
  await mkdir(path.join(dir, "infra", "dev"), { recursive: true });
  if (prodCompose) {
    await writeFile(path.join(dir, "infra", "prod", "compose.yaml"), "services: {}\n");
  }
  if (devCompose) {
    await writeFile(path.join(dir, "infra", "dev", "compose.yaml"), "services: {}\n");
  }
  if (prodEnv) {
    await writeFile(path.join(dir, "infra", "prod", ".env"), "POSTGRES_PASSWORD=x\n");
  }
  if (devEnv) {
    await writeFile(path.join(dir, "infra", "dev", ".env"), "POSTGRES_PASSWORD=x\n");
  }
  return dir;
};

// Base env with any inherited COMPOSE_DIR stripped, so a variable left over
// from the developer's own shell can never leak into a fixture run.
const cleanEnv = (overrides = {}) => {
  const env = { ...process.env, ...overrides };
  if (!("COMPOSE_DIR" in overrides)) delete env.COMPOSE_DIR;
  return env;
};

const runBash = async (args, { cwd, env = {} }) => {
  try {
    const { stdout, stderr } = await run("bash", args, { cwd, env: cleanEnv(env) });
    return { code: 0, stdout, stderr };
  } catch (err) {
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? "" };
  }
};

// Exercises exactly what backup-db.sh, restore-db.sh and deploy.sh all call:
// `source lib/compose-dir.sh; require_compose_dir`.
const requireComposeDir = (dir, env = {}) =>
  runBash(["-c", `source "${libPath}"; require_compose_dir`], { cwd: dir, env });

test("an explicit COMPOSE_DIR always wins, even with both markers present", async () => {
  const dir = await fixture({ prodEnv: true, devEnv: true });
  const { code, stdout, stderr } = await requireComposeDir(dir, { COMPOSE_DIR: "infra/dev" });
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "infra/dev");
  assert.match(stderr, /Using COMPOSE_DIR=infra\/dev/);
});

test("production is selected when only the production marker is present", async () => {
  const dir = await fixture({ prodEnv: true, devEnv: false });
  const { code, stdout, stderr } = await requireComposeDir(dir);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "infra/prod");
  assert.match(stderr, /Using COMPOSE_DIR=infra\/prod/);
});

test("dev is selected when only the dev marker is present", async () => {
  const dir = await fixture({ prodEnv: false, devEnv: true });
  const { code, stdout, stderr } = await requireComposeDir(dir);
  assert.equal(code, 0);
  assert.equal(stdout.trim(), "infra/dev");
  assert.match(stderr, /Using COMPOSE_DIR=infra\/dev/);
});

test("neither marker present refuses to guess and names the override", async () => {
  const dir = await fixture({ prodEnv: false, devEnv: false });
  const { code, stdout, stderr } = await requireComposeDir(dir);
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /COMPOSE_DIR/);
  assert.match(stderr, /infra\/prod\/\.env/);
  assert.match(stderr, /infra\/dev\/\.env/);
});

test("both markers present is ambiguous, not a silent guess", async () => {
  // Not one of the four required scenarios, but the resolver must not pick a
  // side quietly here either -- see the comment in lib/compose-dir.sh.
  const dir = await fixture({ prodEnv: true, devEnv: true });
  const { code, stdout, stderr } = await requireComposeDir(dir);
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /COMPOSE_DIR/);
});

test("a resolved directory without compose.yaml fails instead of misleading docker", async () => {
  const dir = await fixture({ prodEnv: true, prodCompose: false });
  const { code, stdout, stderr } = await requireComposeDir(dir);
  assert.notEqual(code, 0);
  assert.equal(stdout, "");
  assert.match(stderr, /compose\.yaml/);
});

test("backup-db.sh fails before ever invoking docker when neither stack is configured", async () => {
  const dir = await fixture({ prodEnv: false, devEnv: false });
  const { code, stdout, stderr } = await runBash([backupScriptPath, "backups"], { cwd: dir });

  assert.notEqual(code, 0);
  assert.match(stderr, /COMPOSE_DIR/);
  // "Backing up database" is the first thing backup-db.sh prints AFTER
  // COMPOSE_DIR resolves and OUT_DIR is created -- its absence, together with
  // OUT_DIR never existing, is proof the script stopped before touching
  // docker or postgres at all, not just that it eventually errored out.
  assert.doesNotMatch(stdout, /Backing up database/);
  await assert.rejects(access(path.join(dir, "backups")));
});

test("the compose directory is printed for an operator to see before anything runs", async () => {
  const dir = await fixture({ prodEnv: true });
  const { stderr } = await requireComposeDir(dir);
  assert.match(stderr, /Using COMPOSE_DIR=infra\/prod/);
});

// backup-db.sh and restore-db.sh must resolve COMPOSE_DIR identically --
// restore is destructive, so it may never be the more lenient of the two.
test("restore-db.sh and deploy.sh resolve COMPOSE_DIR the same way as backup-db.sh", async () => {
  const [backup, restore, deploy] = await Promise.all([
    readFile(new URL("../backup-db.sh", import.meta.url), "utf8"),
    readFile(new URL("../restore-db.sh", import.meta.url), "utf8"),
    readFile(new URL("../deploy.sh", import.meta.url), "utf8"),
  ]);
  for (const script of [backup, restore, deploy]) {
    assert.match(script, /\. "\$SCRIPT_DIR\/lib\/compose-dir\.sh"/);
    assert.match(script, /COMPOSE_DIR="\$\(require_compose_dir\)" \|\| exit 1/);
  }
  // Neither script silently falls back to the old hardcoded default anymore.
  assert.doesNotMatch(backup, /COMPOSE_DIR:-infra\/dev/);
  assert.doesNotMatch(restore, /COMPOSE_DIR:-infra\/dev/);
  assert.doesNotMatch(deploy, /COMPOSE_DIR:-infra\/dev/);
});

test("restore-db.sh also refuses to guess when neither stack is configured", async () => {
  const dir = await fixture({ prodEnv: false, devEnv: false });
  // A dump path is required before COMPOSE_DIR is even read; give it a
  // nonexistent one so the only possible failure reason is resolution.
  const { code, stdout, stderr } = await runBash(
    [restoreScriptPath, path.join(dir, "no-such-dump.sql.gz")],
    { cwd: dir },
  );
  assert.notEqual(code, 0);
  assert.match(stderr, /COMPOSE_DIR/);
  assert.doesNotMatch(stdout, /Restoring/);
});

test("deploy.sh fails before invoking docker when neither stack is configured", async () => {
  const dir = await fixture({ prodEnv: false, devEnv: false });
  const { code, stdout, stderr } = await runBash([deployScriptPath], { cwd: dir });

  assert.notEqual(code, 0);
  assert.match(stderr, /COMPOSE_DIR/);
  // The deploy script fails at require_compose_dir before reaching the
  // "Backing up the database" message (first output after COMPOSE_DIR resolves)
  // or any docker invocation. Absence of both messages and no backups directory
  // proves it exited during resolution, not during execution.
  assert.doesNotMatch(stdout, /Backing up/);
  assert.doesNotMatch(stdout, /\[1\/4\]/);
  await assert.rejects(access(path.join(dir, "backups")));
});
