import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const scriptPath = fileURLToPath(new URL("../scripts/cotenants.sh", import.meta.url));

// These need a POSIX shell and a fake `docker` on PATH. They skip on the
// Windows dev box and run in the `infra` CI job.
const executing = {
  skip: process.platform === "linux" ? false : "needs a POSIX shell",
};

/**
 * A fake `docker` driven by a table of containers.
 *
 * Each entry is `name|project|running|ports`. `project` empty means the
 * container carries no compose labels at all - which is exactly what a legacy
 * AmneziaVPN desktop-client install looks like, and the case the guard exists
 * for.
 */
const fixture = async (containers) => {
  const root = await mkdtemp(join(tmpdir(), "cotenants-"));
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  const table = join(root, "containers");
  await writeFile(table, `${containers.join("\n")}\n`);

  const docker = `#!/usr/bin/env bash
case "$1" in
  ps)
    # Only running containers, like the real \`docker ps\`.
    while IFS='|' read -r name project running ports; do
      [ -n "$name" ] || continue
      [ "$running" = true ] || continue
      printf '%s\\n' "$name"
    done <"$TABLE"
    exit 0 ;;
  inspect)
    target="\${*: -1}"
    while IFS='|' read -r name project running ports; do
      [ "$name" = "$target" ] || continue
      printf '%s|%s|%s\\n' "$project" "$running" "$ports"
      exit 0
    done <"$TABLE"
    exit 1 ;;
esac
exit 0
`;
  await writeFile(join(bin, "docker"), docker, { mode: 0o755 });
  await chmod(join(bin, "docker"), 0o755);

  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, TABLE: table };
  const run = (...args) =>
    spawnSync("sh", [scriptPath, ...args], { env, encoding: "utf8" });
  const setTable = (rows) => writeFile(table, `${rows.join("\n")}\n`);

  return {
    root,
    env,
    run,
    setTable,
    snapshotPath: join(root, "snapshot"),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
};

const OURS = "amnezia-node-agent|amnezia-node|true|51890/udp";
const LEGACY = "amnezia-awg|| true|48187/udp".replace("| true", "|true");
const OUTLINE = "shadowbox||true|443/tcp";

test("the snapshot lists co-tenants and never our own containers", executing, async (t) => {
  const f = await fixture([OURS, LEGACY, OUTLINE]);
  t.after(f.cleanup);

  const result = f.run("snapshot", f.snapshotPath);

  assert.equal(result.status, 0, result.stderr);
  const saved = await readFile(f.snapshotPath, "utf8");
  const names = saved.split("\n").filter(Boolean).map((line) => line.split("\t")[0]);
  // A legacy AmneziaVPN desktop install carries no compose labels at all, so an
  // "is it labelled with another project" test would let it through - which is
  // how a co-tenant becomes invisible to the thing meant to protect it.
  assert.deepEqual(names.sort(), ["amnezia-awg", "shadowbox"]);
  assert.doesNotMatch(saved, /amnezia-node-agent/);
});

test("verify passes when every co-tenant is untouched", executing, async (t) => {
  const f = await fixture([OURS, LEGACY, OUTLINE]);
  t.after(f.cleanup);
  assert.equal(f.run("snapshot", f.snapshotPath).status, 0);

  const result = f.run("verify", f.snapshotPath);

  assert.equal(result.status, 0, result.stdout + result.stderr);
});

test("verify fails loudly when a co-tenant stopped during the deploy", executing, async (t) => {
  const f = await fixture([OURS, LEGACY, OUTLINE]);
  t.after(f.cleanup);
  assert.equal(f.run("snapshot", f.snapshotPath).status, 0);

  // This is the whole point: the legacy VPN was running before our deploy and
  // is not running after it. Nothing else in the node scripts notices.
  await f.setTable([OURS, "amnezia-awg||false|48187/udp", OUTLINE]);
  const result = f.run("verify", f.snapshotPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /amnezia-awg/);
  assert.match(result.stderr, /no longer running/i);
});

test("verify fails when a co-tenant vanished entirely", executing, async (t) => {
  const f = await fixture([OURS, LEGACY, OUTLINE]);
  t.after(f.cleanup);
  assert.equal(f.run("snapshot", f.snapshotPath).status, 0);

  await f.setTable([OURS, OUTLINE]);
  const result = f.run("verify", f.snapshotPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /amnezia-awg/);
});

test("verify fails when a co-tenant lost a published port", executing, async (t) => {
  const f = await fixture([OURS, LEGACY, OUTLINE]);
  t.after(f.cleanup);
  assert.equal(f.run("snapshot", f.snapshotPath).status, 0);

  // The quiet failure: the container is still up, `docker ps` looks normal, and
  // its traffic stops because the host no longer forwards its port. A check
  // that only asks "is it running" reports everything is fine.
  await f.setTable([OURS, "amnezia-awg||true|", OUTLINE]);
  const result = f.run("verify", f.snapshotPath);

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /amnezia-awg/);
  assert.match(result.stderr, /port/i);
});

test("a co-tenant that appears during the deploy is not an error", executing, async (t) => {
  const f = await fixture([OURS, LEGACY]);
  t.after(f.cleanup);
  assert.equal(f.run("snapshot", f.snapshotPath).status, 0);

  // Somebody else's container starting is none of our business; only losing one
  // we found is.
  await f.setTable([OURS, LEGACY, OUTLINE]);

  assert.equal(f.run("verify", f.snapshotPath).status, 0);
});

test("an empty snapshot verifies clean on a host with no co-tenants", executing, async (t) => {
  const f = await fixture([OURS]);
  t.after(f.cleanup);
  assert.equal(f.run("snapshot", f.snapshotPath).status, 0);

  assert.equal(await readFile(f.snapshotPath, "utf8"), "");
  assert.equal(f.run("verify", f.snapshotPath).status, 0);
});

test("deploy.sh takes the snapshot before it touches compose, and verifies after", async () => {
  const deploy = (
    await readFile(new URL("../scripts/deploy.sh", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const code = deploy
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

  const snapshotAt = code.search(/cotenants\.sh"? snapshot/);
  const composeAt = code.indexOf("compose up");
  const verifyAt = code.search(/cotenants\.sh"? verify/);

  assert.ok(snapshotAt > 0, "deploy.sh must snapshot the co-tenants");
  assert.ok(verifyAt > 0, "deploy.sh must verify them afterwards");
  // A snapshot taken after compose has already run records the damage as the
  // baseline and can never report it.
  assert.ok(snapshotAt < composeAt, "the snapshot must precede `compose up`");
  assert.ok(composeAt < verifyAt, "the verification must follow it");
});
