import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const nodeDir = fileURLToPath(new URL("..", import.meta.url));
const executing = { skip: process.platform === "linux" ? false : "needs a POSIX shell" };
const REPO = "ghcr.io/owner/repo/node-agent";

const SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >>"$STATE/calls"
if [ "$1" = show ]; then
  if [ -f "$STATE/override" ]; then line="$(cat "$STATE/override")"
  else line="$(sed -n 's/^ExecStart=//p' "$AMNEZIA_UNIT_DIR/$5" | head -n 1)"; fi
  printf '{ path=%s ; argv[]=%s ; ignore_errors=no ; }\\n' "\${line%% *}" "$line"
fi
exit 0
`;

/** A throwaway node directory holding the real installer, templates and updater script. */
const fixture = async (dirName = "node") => {
  const root = await mkdtemp(join(tmpdir(), "install-agent-updater-"));
  const node = join(root, dirName);
  const bin = join(root, "bin");
  const state = join(root, "state");
  const units = join(root, "units");
  for (const dir of [join(node, "scripts"), join(node, "systemd"), bin, state, units]) {
    await mkdir(dir, { recursive: true });
  }
  await cp(join(nodeDir, "scripts", "install-agent-updater.sh"), join(node, "scripts", "install-agent-updater.sh"));
  await cp(join(nodeDir, "scripts", "agent-update.sh"), join(node, "scripts", "agent-update.sh"));
  for (const name of ["amnezia-node-agent-update.service", "amnezia-node-agent-update.path"]) {
    await cp(join(nodeDir, "systemd", name), join(node, "systemd", name));
  }
  await chmod(join(node, "scripts", "agent-update.sh"), 0o644);
  await writeFile(join(node, "compose.yaml"), "services: {}\n");
  await writeFile(join(node, ".env"), "NODE_AGENT_IMAGE=x\n");
  for (const [name, body] of Object.entries({ systemctl: SYSTEMCTL, chown: "#!/bin/sh\nexit 0\n", id: "#!/bin/sh\necho 0\n" })) {
    await writeFile(join(bin, name), body, { mode: 0o755 });
  }
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    STATE: state,
    AMNEZIA_UNIT_DIR: units,
    AMNEZIA_UNIT_SEARCH_DIRS: units,
    NODE_UPDATE_SPOOL_DIR: join(root, "spool"),
    NODE_AGENT_UPDATE_REPO: REPO,
  };
  return { root, node, state, units, env };
};
const install = (f) =>
  spawnSync("bash", [join(f.node, "scripts", "install-agent-updater.sh")], { env: f.env, encoding: "utf8" });
const calls = (f) => readFile(join(f.state, "calls"), "utf8").catch(() => "");
const SERVICE = "amnezia-node-agent-update.service";

test("the unit launches the script through /bin/bash with the approved repository and spool", executing, async () => {
  const f = await fixture();
  const r = install(f);
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const service = await readFile(join(f.units, SERVICE), "utf8");
  assert.match(service, new RegExp(`^ExecStart=/bin/bash ${f.node}/scripts/agent-update\\.sh$`, "m"));
  assert.ok(service.includes(`Environment=NODE_AGENT_UPDATE_REPO=${REPO}`));
  assert.ok(service.includes(`NODE_UPDATE_SPOOL_DIR=${f.env.NODE_UPDATE_SPOOL_DIR}`));
  assert.ok(service.includes(`AMNEZIA_NODE_DIR=${f.node}`));
  assert.equal((await stat(join(f.node, "scripts", "agent-update.sh"))).mode & 0o777, 0o644);
  const log = await calls(f);
  assert.ok(log.indexOf("daemon-reload") < log.indexOf("enable --now amnezia-node-agent-update.path"));
});

test("a node directory in a custom location is rendered into the unit", executing, async () => {
  const f = await fixture("srv/custom-node");
  assert.equal(install(f).status, 0);
  const service = await readFile(join(f.units, SERVICE), "utf8");
  assert.ok(service.includes(`ExecStart=/bin/bash ${f.node}/scripts/agent-update.sh`));
  assert.ok(!service.includes("/opt/amnezia-node"));
});

test("a script with a syntax error is refused before anything is installed", executing, async () => {
  const f = await fixture();
  await writeFile(join(f.node, "scripts", "agent-update.sh"), "if then\n");
  const r = install(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /syntax error/);
  assert.equal(await calls(f), "");
});

test("a drop-in that overrides ExecStart is rejected and the unit is named", executing, async () => {
  const f = await fixture();
  const dropin = join(f.units, `${SERVICE}.d`);
  await mkdir(dropin);
  await writeFile(join(dropin, "x.conf"), "[Service]\nExecStart=/usr/local/bin/mine.sh\n");
  const r = install(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /amnezia-node-agent-update\.service: drop-in .*x\.conf overrides ExecStart/);
  assert.equal(await calls(f), "");
});

test("an override only systemd can see stops the install before the watcher is armed", executing, async () => {
  const f = await fixture();
  await writeFile(join(f.state, "override"), "/usr/local/bin/mine.sh");
  const r = install(f);
  assert.equal(r.status, 1);
  assert.match(r.stdout, /amnezia-node-agent-update\.service: effective ExecStart is not/);
  assert.match(r.stdout, /already written .* reloaded, but the watcher was NOT enabled/);
  assert.ok(!(await calls(f)).includes("enable"));
});
