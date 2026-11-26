import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const normalize = (text) => text.replace(/\r\n/g, "\n");
const readScript = async (rel) =>
  normalize(await readFile(new URL(`../scripts/${rel}`, import.meta.url), "utf8"));

const canExecuteLinux =
  process.platform === "linux" && spawnSync("tar", ["--version"]).stdout?.includes("GNU tar");
const executing = { skip: canExecuteLinux ? false : "needs Linux GNU tar and POSIX sh" };

test("common.sh, backup.sh, deploy.sh, and rollback.sh support AWG3-only nodes", async () => {
  const common = await readScript("common.sh");
  const backup = await readScript("backup.sh");
  const deploy = await readScript("deploy.sh");
  const rollback = await readScript("rollback.sh");

  // None of them may unconditionally abort when state/amnezia-awg2/awg0.conf is missing.
  assert.doesNotMatch(common, /\[ -s "\$STATE_DIR\/awg0\.conf" \] \|\| return 2/);
  assert.match(common, /has_awg2=0/);
  assert.match(common, /has_awg3=0/);
  assert.match(common, /\[ -s "\$STATE_DIR_AWG3\/awg0\.conf" \] && has_awg3=1/);
  assert.match(backup, /Neither AWG2 nor AWG3 state is initialized/);
  assert.match(deploy, /\[ -s "\$STATE_DIR\/awg0\.conf" \] \|\| \[ -s "\$STATE_DIR_AWG3\/awg0\.conf" \]/);
  assert.match(rollback, /backup contains neither AWG2 nor AWG3 state/);
});

test("validate_backup_archive allowlists only state/amnezia-awg[23] and egress/{state.json,meta.env}", async () => {
  const common = await readScript("common.sh");
  const fnStart = common.indexOf("validate_backup_archive() {");
  assert.notEqual(fnStart, -1);
  const fn = common.slice(fnStart);

  assert.match(fn, /\^\s*\\\/\s*\|\|\s*|\^\\\//);
  assert.match(fn, /state\\\/amnezia-awg\[23\]/);
  assert.match(fn, /"egress\/state\.json"/);
  assert.match(fn, /"egress\/meta\.env"/);
  assert.match(fn, /type != "d" && type != "-"/);
});

test("rollback.sh uses 256 MiB disk floor and parses meta.env without source/eval", async () => {
  const rollback = await readScript("rollback.sh");
  const preflight = await readScript("preflight.sh");

  assert.match(rollback, /PREFLIGHT_DISK_MIN_KB=262144 sh "\$SCRIPT_DIR\/preflight\.sh"/);
  assert.match(preflight, /PREFLIGHT_DISK_MIN_KB/);
  assert.match(rollback, /AWG3_EGRESS_MODE=/);
  assert.doesNotMatch(rollback, /(?:^|\s)(?:\.|source|eval)\s+.*meta\.env/m);
  assert.match(rollback, /sync_host_egress_after_restore/);
  assert.match(rollback, /amnezia-egressd (reconcile|teardown)/);
  assert.match(rollback, /--socket "\$EGRESS_SOCKET"/);
  assert.match(rollback, /had_previous_egress_state/);
  assert.match(rollback, /EGRESS_MODE_FILE="\$STATE_DIR_AWG3\/egress-mode"/);
  assert.match(rollback, /conntrack -D -s 10\.90\.0\.0\/22/);
  assert.ok(
    rollback.indexOf("compose up --detach --no-build &&") <
      rollback.indexOf('sync_host_egress_after_restore "$effective_mode"'),
    "sync_host_egress_after_restore must run after compose up creates br-awg-egress",
  );
  assert.doesNotMatch(
    rollback.slice(
      rollback.indexOf("sync_host_egress_after_restore() {"),
      rollback.indexOf("effective_mode="),
    ),
    /amnezia-egressd reconcile.*\|\| true/,
  );
});

test("create_backup packages AWG3 + egress state.json + meta.env, validates cleanly, and prunes beyond BACKUP_KEEP_COUNT", executing, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amnezia-node-backup-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const nodeDir = join(root, "node");
  const scriptsDir = join(nodeDir, "scripts");
  const binDir = join(root, "bin");
  await mkdir(join(nodeDir, "state", "amnezia-awg2"), { recursive: true });
  await mkdir(join(nodeDir, "state", "amnezia-awg3"), { recursive: true });
  await mkdir(join(nodeDir, "backups"), { recursive: true });
  await mkdir(scriptsDir, { recursive: true });
  await mkdir(binDir, { recursive: true });

  await writeFile(join(scriptsDir, "common.sh"), await readScript("common.sh"), { mode: 0o755 });
  await writeFile(join(nodeDir, ".env"), "AWG3_EGRESS_MODE=routed\n", { mode: 0o600 });
  await writeFile(join(nodeDir, "compose.yaml"), "services: {}\n");
  await writeFile(
    join(nodeDir, "state", "amnezia-awg3", "awg0.conf"),
    "[Interface]\nAddress = 10.90.0.1/22\nListenPort = 51890\n",
    { mode: 0o600 },
  );
  await writeFile(join(nodeDir, "state", "amnezia-awg3", "clientsTable"), "[]\n", { mode: 0o600 });

  const egressStatePath = join(root, "egress-state.json");
  await writeFile(egressStatePath, '{"schemaVersion":1,"exits":[],"peers":[]}\n', { mode: 0o600 });

  // Fake docker reports containers not running
  await writeFile(join(binDir, "docker"), "#!/bin/sh\necho false\n", { mode: 0o755 });
  await chmod(join(binDir, "docker"), 0o755);

  const env = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH}`,
    EGRESS_STATE_FILE: egressStatePath,
    BACKUP_KEEP_COUNT: "2",
  };

  // Seed 2 older backups so creating a 3rd prunes the oldest down to 2 pairs.
  for (const oldStamp of ["20260101T000001Z", "20260101T000002Z"]) {
    const p = join(nodeDir, "backups", `amnezia-node-${oldStamp}.tar.gz`);
    await writeFile(p, "dummy", { mode: 0o600 });
    await writeFile(`${p}.sha256`, "dummy", { mode: 0o600 });
  }

  const res = spawnSync(
    "sh",
    [
      "-c",
      `. "${scriptsDir}/common.sh"\na=$(create_backup 0)\nvalidate_backup_archive "$a"\nprintf '%s' "$a"`,
      `${scriptsDir}/common.sh`,
    ],
    { env, encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr + res.stdout);
  const createdArchive = res.stdout.trim();
  const list = spawnSync("tar", ["-tzf", createdArchive], { encoding: "utf8" });
  assert.equal(list.status, 0);
  assert.match(list.stdout, /state\/amnezia-awg3\/awg0\.conf/);
  assert.match(list.stdout, /egress\/meta\.env/);
  assert.match(list.stdout, /egress\/state\.json/);
  assert.doesNotMatch(list.stdout, /state\/amnezia-awg2/);

  const remainingTarballs = (await readdir(join(nodeDir, "backups"))).filter((f) => f.endsWith(".tar.gz"));
  assert.equal(remainingTarballs.length, 2, `expected 2 retained tarballs, got ${remainingTarballs}`);
  assert.equal(remainingTarballs.includes("amnezia-node-20260101T000001Z.tar.gz"), false);
});

test("validate_backup_archive rejects disallowed paths", executing, async (t) => {
  const root = await mkdtemp(join(tmpdir(), "amnezia-bad-archive-"));
  t.after(() => rm(root, { recursive: true, force: true }));

  const nodeDir = join(root, "node");
  const scriptsDir = join(nodeDir, "scripts");
  await mkdir(scriptsDir, { recursive: true });
  await writeFile(join(scriptsDir, "common.sh"), await readScript("common.sh"), { mode: 0o755 });

  await mkdir(join(root, "evil", "secrets"), { recursive: true });
  await writeFile(join(root, "evil", "secrets", "key"), "secret");
  const badTar = join(root, "bad.tar.gz");
  spawnSync("tar", ["-C", join(root, "evil"), "-czf", badTar, "secrets/key"]);

  const res = spawnSync(
    "sh",
    ["-c", `. "${scriptsDir}/common.sh"\nvalidate_backup_archive "${badTar}"`],
    { encoding: "utf8" },
  );
  assert.notEqual(res.status, 0);
  assert.match(res.stderr, /unsafe path/);
});
