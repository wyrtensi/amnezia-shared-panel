import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const prodDir = fileURLToPath(new URL("..", import.meta.url));
const executing = { skip: process.platform === "linux" ? false : "needs a POSIX shell" };

// systemctl, chown and id are PATH stubs; units go to a throwaway directory.
const SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >>"$STATE/calls"
if [ "$1" = show ]; then
  if [ -f "$STATE/override" ]; then line="$(cat "$STATE/override")"
  else line="$(sed -n 's/^ExecStart=//p' "$AMNEZIA_UNIT_DIR/$5" | head -n 1)"; fi
  printf '{ path=%s ; argv[]=%s ; ignore_errors=no ; }\\n' "\${line%% *}" "$line"
fi
exit 0
`;

/** A throwaway checkout holding the real installer, templates and updater script. */
const fixture = async (checkout = "checkout") => {
  const root = await mkdtemp(join(tmpdir(), "install-updater-"));
  const repo = join(root, checkout);
  const prod = join(repo, "infra", "prod");
  const bin = join(root, "bin");
  const state = join(root, "state");
  const units = join(root, "units");
  for (const dir of [prod, bin, state, units]) await mkdir(dir, { recursive: true });
  for (const name of ["install-updater.sh", "panel-updater.sh", "panel-updater.service", "panel-updater.path"]) {
    await cp(join(prodDir, name), join(prod, name));
  }
  await chmod(join(prod, "panel-updater.sh"), 0o644);
  for (const [name, body] of Object.entries({ systemctl: SYSTEMCTL, chown: "#!/bin/sh\nexit 0\n", id: "#!/bin/sh\necho 0\n" })) {
    await writeFile(join(bin, name), body, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STATE: state,
    AMNEZIA_UNIT_DIR: units,
    AMNEZIA_UNIT_SEARCH_DIRS: units,
    UPDATE_SPOOL_HOST_DIR: join(root, "spool"),
  };
  return { root, repo, prod, state, units, env };
};
const install = (f) => spawnSync("bash", [join(f.prod, "install-updater.sh")], { env: f.env, encoding: "utf8" });
const calls = (f) => readFile(join(f.state, "calls"), "utf8").catch(() => "");

test("the unit launches the script through /bin/bash, whatever its mode", executing, async () => {
  const f = await fixture();
  const r = install(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const service = await readFile(join(f.units, "panel-updater.service"), "utf8");
  assert.match(service, new RegExp(`^ExecStart=/bin/bash ${f.prod}/panel-updater\\.sh$`, "m"));
  assert.ok(service.includes(`UPDATE_SPOOL_HOST_DIR=${f.env.UPDATE_SPOOL_HOST_DIR}`));
  assert.equal((await stat(join(f.prod, "panel-updater.sh"))).mode & 0o777, 0o644, "the script's mode is not touched");
  const log = await calls(f);
  assert.ok(log.indexOf("daemon-reload") < log.indexOf("enable --now panel-updater.path"));
});

test("a checkout in a custom location is rendered into the unit", executing, async () => {
  const f = await fixture("srv/panel-checkout");
  assert.equal(install(f).status, 0);
  const service = await readFile(join(f.units, "panel-updater.service"), "utf8");
  assert.ok(service.includes(`ExecStart=/bin/bash ${f.repo}/infra/prod/panel-updater.sh`));
  assert.ok(!service.includes("/opt/amnezia-panel"));
});

test("a script with a syntax error is refused before anything is installed", executing, async () => {
  const f = await fixture();
  await writeFile(join(f.prod, "panel-updater.sh"), "if then\n");
  const r = install(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /syntax error/);
  assert.equal(await calls(f), "");
  assert.equal(await readFile(join(f.units, "panel-updater.service"), "utf8").catch(() => "none"), "none");
});

test("a missing script is refused", executing, async () => {
  const f = await fixture();
  await writeFile(join(f.prod, "panel-updater.sh"), "");
  spawnSync("rm", ["-f", join(f.prod, "panel-updater.sh")]);
  const r = install(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /not a readable file/);
});

test("a drop-in that overrides ExecStart is rejected and the unit is named", executing, async () => {
  const f = await fixture();
  const dropin = join(f.units, "panel-updater.service.d");
  await mkdir(dropin);
  await writeFile(join(dropin, "x.conf"), "[Service]\nExecStart=\nExecStart=/usr/local/bin/mine.sh\n");
  const r = install(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /panel-updater\.service: drop-in .*x\.conf overrides ExecStart/);
  assert.equal(await calls(f), "", "nothing was installed or enabled");
});

test("an override systemd reports but the installer cannot see is caught before the watcher is armed", executing, async () => {
  const f = await fixture();
  await writeFile(join(f.state, "override"), "/usr/local/bin/mine.sh");
  const r = install(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /panel-updater\.service: effective ExecStart is not '\/bin\/bash /);
  assert.ok(!(await calls(f)).includes("enable"), "watcher not enabled");
});
