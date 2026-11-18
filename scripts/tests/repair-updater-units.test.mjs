import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { chmod, cp, mkdir, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

// systemctl, systemd-analyze and id are PATH stubs over a throwaway state dir:
// no test touches the machine's real units.
const tool = fileURLToPath(new URL("../repair-updater-units.sh", import.meta.url));
const repo = fileURLToPath(new URL("../..", import.meta.url));
const canExecute =
  process.platform === "linux" && spawnSync("flock", ["--version"]).status === 0;
const executing = { skip: canExecute ? false : "needs Linux bash + flock" };

// label, unit base, template service, template path, default script path, lock dir
const UPDATERS = {
  panel: {
    base: "panel-updater",
    service: "infra/prod/panel-updater.service",
    path: "infra/prod/panel-updater.path",
    script: "/opt/amnezia-panel/infra/prod/panel-updater.sh",
    lock: "/run/amnezia-panel",
    spool: "/var/lib/amnezia-panel/update",
  },
  node: {
    base: "amnezia-node-agent-update",
    service: "infra/node/systemd/amnezia-node-agent-update.service",
    path: "infra/node/systemd/amnezia-node-agent-update.path",
    script: "/opt/amnezia-node/scripts/agent-update.sh",
    lock: "/run/amnezia-node",
    spool: "/var/lib/amnezia-node/update",
  },
  bridge: {
    base: "amnezia-bridge-agent-update",
    service: "infra/bridge/systemd/amnezia-bridge-agent-update.service",
    path: "infra/bridge/systemd/amnezia-bridge-agent-update.path",
    script: "/opt/amnezia-bridge/bridge-agent-update.sh",
    lock: "/run/amnezia-bridge-updater",
    spool: "/var/lib/amnezia-bridge/update",
  },
};
const LABEL = { panel: "panel", node: "node-agent", bridge: "bridge-agent" };

const SYSTEMCTL = `#!/bin/sh
echo "systemctl $*" >>"$STATE/calls"
cmd="$1"; shift
case "$cmd" in
  show)
    [ ! -f "$STATE/show-fails" ] || exit 1
    prop="$2"; unit="$4"
    case "$prop" in
      ExecStart)
        if [ -f "$STATE/override-$unit" ]; then line="$(cat "$STATE/override-$unit")"
        else line="$(sed -n 's/^ExecStart=//p' "$UNIT_DIR/$unit" | head -n 1)"; fi
        printf '{ path=%s ; argv[]=%s ; ignore_errors=no ; }\\n' "\${line%% *}" "$line" ;;
      SubState)
        if [ "$(cat "$STATE/active-$unit" 2>/dev/null)" = active ]; then echo waiting; else echo dead; fi ;;
    esac ;;
  is-enabled)
    v="$(cat "$STATE/enabled-$1" 2>/dev/null || echo disabled)"; echo "$v"; [ "$v" = enabled ] ;;
  is-active)
    v="$(cat "$STATE/active-$1" 2>/dev/null || echo inactive)"; echo "$v"; [ "$v" = active ] ;;
  reset-failed)
    echo inactive >"$STATE/active-$1"
    [ ! -f "$STATE/inject-on-reset" ] || cp "$STATE/inject-body" "$(cat "$STATE/inject-on-reset")" ;;
  start)
    [ ! -f "$STATE/start-fails" ] || exit 1
    echo active >"$STATE/active-$1" ;;
  daemon-reload)
    # A request that arrives while the tool is between verify and rearm.
    [ ! -f "$STATE/inject" ] || { cp "$STATE/inject-body" "$(cat "$STATE/inject")"; } ;;
  *) echo "unexpected systemctl $cmd" >>"$STATE/unexpected"; exit 0 ;;
esac
`;
const ANALYZE = `#!/bin/sh
echo "systemd-analyze $1 $(grep '^ExecStart=' "$2")" >>"$STATE/calls"
[ ! -f "$STATE/verify-fails" ] || { echo "bad unit" >&2; exit 1; }
`;

const readOr = (path) => readFile(path, "utf8").catch(() => "");

const fixture = async () => {
  const root = await mkdtemp(join(tmpdir(), "repair-units-"));
  const f = { root, unitDir: join(root, "units"), state: join(root, "state"), bin: join(root, "bin") };
  for (const dir of [f.unitDir, f.state, f.bin]) await mkdir(dir, { recursive: true });
  await writeFile(join(f.bin, "systemctl"), SYSTEMCTL, { mode: 0o755 });
  await writeFile(join(f.bin, "systemd-analyze"), ANALYZE, { mode: 0o755 });
  await writeFile(join(f.bin, "id"), "#!/bin/sh\necho 0\n", { mode: 0o755 });
  f.env = {
    ...process.env,
    PATH: `${f.bin}:${process.env.PATH}`,
    STATE: f.state,
    UNIT_DIR: f.unitDir,
    // The same lookup the installers use, redirected into the fixture.
    AMNEZIA_UNIT_SEARCH_DIRS: `${f.unitDir} ${join(root, "run-units")}`,
  };
  return f;
};

/**
 * Install one updater the way an OLD installer left it: bare-path ExecStart, the
 * script checked out 0644, every path under the fixture.
 */
const install = async (f, name, { legacy = true, dirs = "default", enabled = "enabled", active = "active" } = {}) => {
  const u = UPDATERS[name];
  const home = join(f.root, dirs, name);
  const script = join(home, u.script.split("/").pop());
  const lock = join(home, "lock");
  const spool = join(home, "spool");
  await mkdir(join(spool, "requests"), { recursive: true });
  await mkdir(lock, { recursive: true });
  await writeFile(script, "#!/bin/bash\nexit 0\n", { mode: 0o644 });
  await chmod(script, 0o644);
  let service = await readFile(join(repo, u.service), "utf8");
  service = service
    .replaceAll(u.script, script)
    .replaceAll(/^(Environment=AMNEZIA_\w+_DIR)=.*$/gm, `$1=${home}`)
    .replaceAll(u.lock, lock)
    .replaceAll(u.spool, spool);
  if (legacy) service = service.replace(/^ExecStart=\/bin\/bash /m, "ExecStart=");
  let pathUnit = await readFile(join(repo, u.path), "utf8");
  pathUnit = pathUnit.replaceAll("/var/lib/amnezia-bridge/updater", join(home, "state")).replaceAll(u.spool, spool);
  await mkdir(join(home, "state"), { recursive: true });
  await writeFile(join(f.unitDir, `${u.base}.service`), service);
  await writeFile(join(f.unitDir, `${u.base}.path`), pathUnit);
  await chmod(join(f.unitDir, `${u.base}.service`), 0o644);
  await writeFile(join(f.state, `enabled-${u.base}.path`), enabled);
  await writeFile(join(f.state, `active-${u.base}.path`), active);
  return { ...u, home, script, lock, spool, requests: name === "bridge" ? join(spool, "requests") : spool };
};

const run = (f, ...args) =>
  spawnSync("bash", [tool, "--unit-dir", f.unitDir, ...args], { env: f.env, encoding: "utf8" });
const runJson = (f, ...args) => {
  const r = run(f, "--json", ...args);
  return { ...r, report: JSON.parse(r.stdout) };
};
const unit = (report, label) => report.units.find((u) => u.updater === LABEL[label]);
const calls = async (f) => (await readOr(join(f.state, "calls"))).split("\n").filter(Boolean);
const mutating = (lines) =>
  lines.filter((l) => /^systemctl (daemon-reload|reset-failed|start|enable|disable|stop|restart)/.test(l));

test("every shipped updater unit starts its script through /bin/bash with an absolute path", () => {
  for (const u of Object.values(UPDATERS)) {
    const text = spawnSync("cat", [join(repo, u.service)], { encoding: "utf8" }).stdout;
    assert.match(text, new RegExp(`^ExecStart=/bin/bash ${u.script.replaceAll("/", "\\/")}$`, "m"), u.service);
  }
});

test("repair rewrites only ExecStart, clears the failed watcher and returns it to waiting", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  await writeFile(join(f.state, "active-panel-updater.service"), "failed");
  await writeFile(join(p.spool, "result.json"), '{"id":"old","ok":true}\n');
  const before = await readFile(join(f.unitDir, "panel-updater.service"), "utf8");
  const resultBefore = await readFile(join(p.spool, "result.json"), "utf8");

  const r = runJson(f);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(unit(r.report, "panel").outcome, "repaired");

  const after = await readFile(join(f.unitDir, "panel-updater.service"), "utf8");
  assert.equal(
    after,
    before.replace(/^ExecStart=(\/\S+)$/m, "ExecStart=/bin/bash $1"),
    "only the ExecStart line changes (paths, spool, lock, timeout stay)",
  );
  assert.match(after, new RegExp(`^ExecStart=/bin/bash ${p.script}$`, "m"));
  assert.equal((await stat(join(f.unitDir, "panel-updater.service"))).mode & 0o777, 0o644);

  const log = await calls(f);
  const order = ["systemd-analyze verify", "systemctl daemon-reload", "systemctl reset-failed panel-updater.service", "systemctl reset-failed panel-updater.path", "systemctl start panel-updater.path"].map((needle) =>
    log.findIndex((l) => l.startsWith(needle)),
  );
  assert.ok(order.every((i) => i >= 0), `all steps ran: ${log.join(" | ")}`);
  assert.deepEqual([...order].sort((a, b) => a - b), order, "verify, reload, reset-failed, start in order");
  assert.ok(log.some((l) => l.startsWith("systemd-analyze verify") && l.endsWith(`ExecStart=/bin/bash ${p.script}`)), "verified the corrected unit");
  assert.ok(!log.some((l) => /^systemctl (enable|disable)/.test(l)), "enablement is never changed");
  assert.equal(await readOr(join(f.state, "unexpected")), "");
  assert.equal(unit(r.report, "panel").watcher, "waiting");
  assert.equal(await readFile(join(p.spool, "result.json"), "utf8"), resultBefore, "results untouched");
  // The other two updaters are simply not installed here.
  assert.equal(unit(r.report, "node").outcome, "not-installed");
  assert.equal(unit(r.report, "bridge").outcome, "not-installed");
});

test("a second repair is a no-op", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { active: "failed" });
  await install(f, "node");
  assert.equal(run(f).status, 0);
  const unitsAfterFirst = await Promise.all(
    ["panel-updater", "amnezia-node-agent-update"].map((b) => readFile(join(f.unitDir, `${b}.service`), "utf8")),
  );
  await writeFile(join(f.state, "calls"), "");

  const r = runJson(f);
  assert.equal(r.status, 0);
  assert.equal(unit(r.report, "panel").outcome, "current");
  assert.equal(unit(r.report, "node").outcome, "current");
  assert.deepEqual(mutating(await calls(f)), [], "no reload, no reset, no start");
  assert.deepEqual(
    await Promise.all(["panel-updater", "amnezia-node-agent-update"].map((b) => readFile(join(f.unitDir, `${b}.service`), "utf8"))),
    unitsAfterFirst,
  );
});

test("dry run reports the inventory and changes nothing", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  const before = await readFile(join(f.unitDir, "panel-updater.service"), "utf8");

  const r = runJson(f, "--dry-run");
  assert.equal(r.status, 0);
  assert.equal(r.report.dryRun, true);
  const rec = unit(r.report, "panel");
  assert.equal(rec.outcome, "would-repair");
  assert.equal(rec.execStart, p.script);
  assert.equal(rec.enabled, "enabled");
  assert.equal(rec.running, false);
  assert.equal(rec.pending, false);
  assert.equal(await readFile(join(f.unitDir, "panel-updater.service"), "utf8"), before);
  assert.deepEqual(mutating(await calls(f)), []);
  assert.ok(!(await calls(f)).some((l) => l.startsWith("systemd-analyze")));

  const table = run(f, "--dry-run").stdout;
  assert.match(table, /UPDATER\s+OUTCOME/);
  assert.match(table, /panel\s+would-repair/);
});

test("custom install paths are kept: the host's script, spool and lock stay as installed", executing, async () => {
  const f = await fixture();
  const n = await install(f, "node", { dirs: "srv/custom-layout", active: "failed" });
  const unitFile = join(f.unitDir, "amnezia-node-agent-update.service");
  // An installed host carries the approved repository its installer wrote.
  await writeFile(unitFile, (await readFile(unitFile, "utf8")).replace(/^Environment=NODE_AGENT_UPDATE_REPO=$/m, "Environment=NODE_AGENT_UPDATE_REPO=ghcr.io/o/r/node-agent"));
  const repoLine = "Environment=NODE_AGENT_UPDATE_REPO=ghcr.io/o/r/node-agent";

  assert.equal(run(f).status, 0);
  const after = await readFile(join(f.unitDir, "amnezia-node-agent-update.service"), "utf8");
  assert.match(after, new RegExp(`^ExecStart=/bin/bash ${n.script}$`, "m"));
  assert.ok(after.includes(repoLine), "approved repository setting is preserved");
  assert.ok(after.includes(`NODE_UPDATE_SPOOL_DIR=${n.spool}`), "spool preserved");
  assert.ok(after.includes(`NODE_UPDATER_LOCK_DIR=${n.lock}`), "lock dir preserved");
  assert.ok(!after.includes("/opt/amnezia-node"), "no template default leaked back in");
});

test("a failed watcher on an already-corrected unit is recovered without rewriting it", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { legacy: false, active: "failed" });
  await writeFile(join(f.state, "active-panel-updater.service"), "failed");
  const before = await readFile(join(f.unitDir, "panel-updater.service"), "utf8");
  const r = runJson(f);
  assert.equal(unit(r.report, "panel").outcome, "repaired");
  assert.equal(await readFile(join(f.unitDir, "panel-updater.service"), "utf8"), before);
  const log = await calls(f);
  assert.ok(!log.some((l) => l.startsWith("systemd-analyze")), "nothing to verify when nothing is rewritten");
  assert.ok(log.includes("systemctl start panel-updater.path"));
});

test("a disabled updater keeps its disabled, stopped state", executing, async () => {
  const f = await fixture();
  await install(f, "node", { enabled: "disabled", active: "inactive" });
  const r = runJson(f);
  assert.equal(unit(r.report, "node").outcome, "repaired");
  assert.equal(unit(r.report, "node").enabled, "disabled");
  assert.match(await readFile(join(f.unitDir, "amnezia-node-agent-update.service"), "utf8"), /^ExecStart=\/bin\/bash \//m);
  const log = await calls(f);
  assert.ok(!log.some((l) => /^systemctl (start|enable)/.test(l)), log.join("|"));
  assert.equal(await readOr(join(f.state, "active-amnezia-node-agent-update.path")), "inactive");
});

test("a pending request defers the repair and reports its id, age and status", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  const request = join(p.spool, "request.json");
  await writeFile(request, '{"id":"req-42","requestedAt":"x"}\n');
  const old = new Date(Date.now() - 3 * 3600 * 1000);
  const { utimes } = await import("node:fs/promises");
  await utimes(request, old, old);
  const unitBefore = await readFile(join(f.unitDir, "panel-updater.service"), "utf8");

  const r = runJson(f);
  assert.equal(r.status, 2, "deferred is its own exit status");
  const rec = unit(r.report, "panel");
  assert.equal(rec.outcome, "deferred-pending");
  assert.equal(rec.pending, true);
  assert.equal(rec.requestId, "req-42");
  assert.equal(rec.requestAge, "3h");
  assert.equal(rec.requestStatus, "queued");
  assert.equal(await readFile(join(f.unitDir, "panel-updater.service"), "utf8"), unitBefore, "unit untouched");
  assert.deepEqual(mutating(await calls(f)), [], "watcher not rearmed");
  assert.equal(await readFile(request, "utf8"), '{"id":"req-42","requestedAt":"x"}\n', "request preserved");
});

test("pending bridge request: status comes from the operation's result", executing, async () => {
  const f = await fixture();
  const b = await install(f, "bridge", { active: "failed" });
  const id = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
  await mkdir(join(b.spool, "results"), { recursive: true });
  await writeFile(join(b.requests, `${id}.json`), `{"operationId":"${id}"}\n`);
  await writeFile(join(b.spool, "results", `${id}.json`), `{"operationId":"${id}","state":"picked_up"}\n`);
  const r = runJson(f);
  const rec = unit(r.report, "bridge");
  assert.equal(rec.outcome, "deferred-pending");
  assert.equal(rec.requestId, id);
  assert.equal(rec.requestStatus, "picked_up");
});

test("an interrupted bridge run (journal present) is reported and deferred", executing, async () => {
  const f = await fixture();
  const b = await install(f, "bridge", { active: "failed" });
  await writeFile(join(b.home, "state", "journal"), "replacing\n");
  const rec = unit(runJson(f).report, "bridge");
  assert.equal(rec.outcome, "deferred-pending");
  assert.equal(rec.requestStatus, "interrupted-run");
});

test("a running operation defers the repair (service active)", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { active: "active" });
  await writeFile(join(f.state, "active-panel-updater.service"), "activating");
  const before = await readFile(join(f.unitDir, "panel-updater.service"), "utf8");
  const r = runJson(f);
  assert.equal(r.status, 2);
  assert.equal(unit(r.report, "panel").outcome, "deferred-running");
  assert.equal(unit(r.report, "panel").running, true);
  assert.equal(await readFile(join(f.unitDir, "panel-updater.service"), "utf8"), before);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("a running operation defers the repair (lock held by a live process)", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel");
  const holder = spawn("flock", [p.lock, "sleep", "30"], { stdio: "ignore" });
  try {
    await new Promise((resolve) => setTimeout(resolve, 400));
    const r = runJson(f);
    assert.equal(unit(r.report, "panel").outcome, "deferred-running");
    assert.deepEqual(mutating(await calls(f)), []);
  } finally {
    holder.kill();
  }
});

test("an updater that is not installed is its own state and stays untouched", executing, async () => {
  const f = await fixture();
  const r = runJson(f);
  assert.equal(r.status, 0);
  for (const label of ["panel", "node", "bridge"]) {
    assert.equal(unit(r.report, label).outcome, "not-installed");
  }
  assert.match(unit(r.report, "node").note, /install-agent-updater\.sh/);
  assert.match(unit(r.report, "panel").note, /install-updater\.sh/);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("the bridge-agent unit is covered: already /bin/bash is current", executing, async () => {
  const f = await fixture();
  await install(f, "bridge", { legacy: false });
  assert.equal(unit(runJson(f).report, "bridge").outcome, "current");
});

test("an ExecStart drop-in override is blocked and the unit is named", executing, async () => {
  const f = await fixture();
  await install(f, "node");
  const dropin = join(f.unitDir, "amnezia-node-agent-update.service.d");
  await mkdir(dropin);
  await writeFile(join(dropin, "override.conf"), "[Service]\nExecStart=\nExecStart=/usr/local/bin/other.sh\n");
  await writeFile(join(f.state, "override-amnezia-node-agent-update.service"), "/usr/local/bin/other.sh");
  const before = await readFile(join(f.unitDir, "amnezia-node-agent-update.service"), "utf8");
  const r = runJson(f);
  assert.equal(r.status, 3);
  const rec = unit(r.report, "node");
  assert.equal(rec.outcome, "blocked");
  assert.equal(rec.unit, "amnezia-node-agent-update");
  assert.match(rec.note, /overridden/);
  assert.equal(await readFile(join(f.unitDir, "amnezia-node-agent-update.service"), "utf8"), before);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("a rejected verify installs nothing", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { active: "failed" });
  await writeFile(join(f.state, "verify-fails"), "");
  const before = await readFile(join(f.unitDir, "panel-updater.service"), "utf8");
  const r = runJson(f);
  assert.equal(r.status, 3);
  assert.equal(unit(r.report, "panel").outcome, "failed");
  assert.equal(await readFile(join(f.unitDir, "panel-updater.service"), "utf8"), before);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("an unreadable or syntactically broken script blocks the repair", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel");
  const n = await install(f, "node");
  await writeFile(p.script, "if then\n");
  await spawnSync("rm", ["-f", n.script]);
  const r = runJson(f);
  assert.equal(r.status, 3);
  assert.equal(unit(r.report, "panel").outcome, "blocked");
  assert.match(unit(r.report, "panel").note, /syntax/);
  assert.equal(unit(r.report, "node").outcome, "blocked");
  assert.match(unit(r.report, "node").note, /not a readable file/);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("each unit is judged independently: a pending one does not stop an idle one", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  await install(f, "node", { active: "failed" });
  await writeFile(join(p.spool, "request.json"), '{"id":"r1"}\n');
  const r = runJson(f);
  assert.equal(unit(r.report, "panel").outcome, "deferred-pending");
  assert.equal(unit(r.report, "node").outcome, "repaired");
  assert.equal(r.status, 2);
});

test("a watcher that does not come back to waiting is reported as failed", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { active: "failed" });
  await writeFile(join(f.state, "start-fails"), "");
  const r = runJson(f);
  assert.equal(r.status, 3);
  assert.equal(unit(r.report, "panel").outcome, "failed");
});

test("refuses to change anything without root, but a dry run does not need it", executing, async () => {
  const f = await fixture();
  await writeFile(join(f.bin, "id"), "#!/bin/sh\necho 1000\n", { mode: 0o755 });
  await install(f, "panel");
  assert.equal(run(f).status, 1);
  assert.equal(run(f, "--dry-run").status, 0);
});

const unitFile = (f, base) => join(f.unitDir, `${base}.service`);
const editUnit = async (f, base, fn) => writeFile(unitFile(f, base), fn(await readFile(unitFile(f, base), "utf8")));

test("a request that appears before rearming defers the watcher but keeps the repaired unit", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  await writeFile(join(f.state, "active-panel-updater.service"), "failed");
  await writeFile(join(f.state, "inject"), join(p.spool, "request.json"));
  await writeFile(join(f.state, "inject-body"), '{"id":"late-1"}\n');
  const r = runJson(f);
  assert.equal(r.status, 2);
  const rec = unit(r.report, "panel");
  assert.equal(rec.outcome, "deferred-pending");
  assert.equal(rec.requestId, "late-1");
  assert.match(await readFile(unitFile(f, "panel-updater"), "utf8"), /^ExecStart=\/bin\/bash /m, "unit stays repaired");
  const log = await calls(f);
  assert.ok(!log.some((l) => /^systemctl (start|reset-failed)/.test(l)), log.join("|"));
  assert.equal(await readFile(join(p.spool, "request.json"), "utf8"), '{"id":"late-1"}\n');
});

test("an operation that starts before rearming defers the watcher", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  try {
    // The first check passes (no lock yet); the lock is taken during daemon-reload.
    await writeFile(
      join(f.bin, "systemctl"),
      (await readFile(join(f.bin, "systemctl"), "utf8")).replace(
        "daemon-reload)",
        `daemon-reload)\n    nohup flock "${p.lock}" sleep 30 >/dev/null 2>&1 &\n    sleep 0.4`,
      ),
    );
    const r = runJson(f);
    assert.equal(unit(r.report, "panel").outcome, "deferred-running");
    assert.ok(!(await calls(f)).some((l) => /^systemctl (start|reset-failed)/.test(l)));
  } finally {
    spawnSync("pkill", ["-f", `flock ${p.lock} sleep 30`]);
  }
});

test("an ExecStart target other than the expected script is blocked", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel");
  await editUnit(f, "panel-updater", (t) => t.replace(/^ExecStart=.*$/m, `ExecStart=${p.home}/other.sh`));
  const rec = unit(runJson(f).report, "panel");
  assert.equal(rec.outcome, "blocked");
  assert.match(rec.note, /not the expected 'panel-updater\.sh'/);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("more than one ExecStart line is blocked", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel");
  await editUnit(f, "panel-updater", (t) => `${t}\nExecStart=${p.script}\n`);
  const rec = unit(runJson(f).report, "panel");
  assert.equal(rec.outcome, "blocked");
  assert.match(rec.note, /2 ExecStart lines/);
});

for (const prefix of ["-", "@", "+", "!"]) {
  test(`an ExecStart with the '${prefix}' prefix is blocked`, executing, async () => {
    const f = await fixture();
    const p = await install(f, "panel");
    await editUnit(f, "panel-updater", (t) => t.replace(/^ExecStart=/m, `ExecStart=${prefix}`));
    await writeFile(join(f.state, "override-panel-updater.service"), `${prefix}${p.script}`);
    const rec = unit(runJson(f).report, "panel");
    assert.equal(rec.outcome, "blocked");
    assert.match(rec.note, /prefix/);
    assert.deepEqual(mutating(await calls(f)), []);
  });
}

test("a continued ExecStart is blocked", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel");
  await editUnit(f, "panel-updater", (t) => t.replace(/^ExecStart=.*$/m, `ExecStart=${p.script} \\\n  --flag`));
  await writeFile(join(f.state, "override-panel-updater.service"), `${p.script} --flag`);
  const rec = unit(runJson(f).report, "panel");
  assert.equal(rec.outcome, "blocked");
  assert.match(rec.note, /continued/);
});

test("a script path with whitespace is blocked", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { dirs: "with space" });
  const rec = unit(runJson(f).report, "panel");
  assert.equal(rec.outcome, "blocked");
  assert.match(rec.note, /whitespace/);
});

test("an ExecStart drop-in in a runtime unit directory is found without asking systemd", executing, async () => {
  const f = await fixture();
  await install(f, "node");
  const dropin = join(f.root, "run-units", "amnezia-node-agent-update.service.d");
  await mkdir(dropin, { recursive: true });
  await writeFile(join(dropin, "x.conf"), "[Service]\nExecStart=/usr/local/bin/mine.sh\n");
  const rec = unit(runJson(f).report, "node");
  assert.equal(rec.outcome, "blocked");
  assert.match(rec.note, /run-units.*x\.conf/);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("an unreadable effective ExecStart is blocked, not assumed from the file", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { active: "failed" });
  await writeFile(join(f.state, "show-fails"), "");
  const before = await readFile(unitFile(f, "panel-updater"), "utf8");
  const r = runJson(f);
  assert.equal(r.status, 3);
  const rec = unit(r.report, "panel");
  assert.equal(rec.outcome, "blocked");
  assert.match(rec.note, /effective ExecStart/);
  assert.equal(await readFile(unitFile(f, "panel-updater"), "utf8"), before);
  assert.deepEqual(mutating(await calls(f)), []);
});

test("a request appearing after reset-failed defers the start, says so, and a later run rearms the watcher", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  await writeFile(join(f.state, "inject-on-reset"), join(p.spool, "request.json"));
  await writeFile(join(f.state, "inject-body"), '{"id":"late-2"}\n');
  const r = runJson(f);
  const rec = unit(r.report, "panel");
  assert.equal(r.status, 2);
  assert.equal(rec.outcome, "deferred-pending");
  assert.equal(rec.requestId, "late-2");
  assert.match(rec.note, /failed state was already cleared/);
  assert.match(rec.note, /NOT started/);
  assert.match(rec.note, /systemctl start panel-updater\.path/);
  assert.doesNotMatch(rec.note, /untouched/);
  assert.equal(rec.watcher, "inactive");
  assert.ok(!(await calls(f)).some((l) => l.startsWith("systemctl start")));

  // The operator resolves the request; the next run completes the rearm.
  await spawnSync("rm", ["-f", join(p.spool, "request.json"), join(f.state, "inject-on-reset")]);
  const again = runJson(f);
  assert.equal(unit(again.report, "panel").outcome, "repaired");
  assert.equal(unit(again.report, "panel").watcher, "waiting");
  assert.ok((await calls(f)).includes("systemctl start panel-updater.path"));
});

test("the deferral before reset-failed gives the exact manual follow-up", executing, async () => {
  const f = await fixture();
  const p = await install(f, "panel", { active: "failed" });
  await writeFile(join(f.state, "inject"), join(p.spool, "request.json"));
  await writeFile(join(f.state, "inject-body"), '{"id":"late-3"}\n');
  const rec = unit(runJson(f).report, "panel");
  assert.match(rec.note, /nothing was reset/);
  assert.match(rec.note, /systemctl reset-failed panel-updater\.service panel-updater\.path && systemctl start panel-updater\.path/);
});

test("an enabled but inactive watcher on a current unit is started", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { legacy: false, active: "inactive" });
  const before = await readFile(unitFile(f, "panel-updater"), "utf8");
  const r = runJson(f);
  assert.equal(unit(r.report, "panel").outcome, "repaired");
  assert.equal(unit(r.report, "panel").watcher, "waiting");
  assert.equal(await readFile(unitFile(f, "panel-updater"), "utf8"), before);
  assert.ok((await calls(f)).includes("systemctl start panel-updater.path"));
});

test("a disabled inactive watcher on a current unit stays untouched", executing, async () => {
  const f = await fixture();
  await install(f, "panel", { legacy: false, enabled: "disabled", active: "inactive" });
  const r = runJson(f);
  assert.equal(unit(r.report, "panel").outcome, "current");
  assert.deepEqual(mutating(await calls(f)), []);
});
