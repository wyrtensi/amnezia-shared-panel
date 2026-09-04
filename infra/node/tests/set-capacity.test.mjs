import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { promisify } from "node:util";

const scriptUrl = new URL("../scripts/set-capacity.sh", import.meta.url);
const script = await readFile(scriptUrl, "utf8");
/** Comments quote the very constructs some of these tests forbid. */
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

const runShellFunction = async (name, ...args) => {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in set-capacity.sh`);
  const end = script.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a top-level function`);
  const body = script.slice(start, end + 3);
  const { stdout } = await promisify(execFile)("sh", [
    "-c",
    `${body}\n${name} ${args.map((value) => `'${value}'`).join(" ")}`,
  ]);
  return stdout.trim();
};

test("mirrors the preflight RAM gate exactly", async () => {
  // preflight.sh: required = 358400 * peers / 500, never below a 192 MiB floor.
  // A raise that the node's own gate would then refuse must be refused here
  // first, or every later deploy of that node fails on a number nobody sees.
  assert.equal(await runShellFunction("required_mem_kb_for", 500), "358400");
  assert.equal(await runShellFunction("required_mem_kb_for", 300), "215040");
  assert.equal(await runShellFunction("required_mem_kb_for", 274), "196608");
  assert.equal(await runShellFunction("required_mem_kb_for", 100), "196608");
  assert.equal(await runShellFunction("required_mem_kb_for", 1000), "716800");
});

test("recreates only the node-agent, never the data plane", async () => {
  // SERVER_MAX_PEERS reaches only the node-agent container, and deploy.sh stops
  // the AWG containers for its pre-deploy backup -- which would drop every
  // tunnel for a one-line .env change.
  assert.match(code, /compose up --detach --no-deps node-agent/);
  assert.doesNotMatch(code, /deploy\.sh/);
  assert.match(code, /wait_healthy amnezia-node-agent/);
});

test("never recreates an AWG container through depends_on", async () => {
  // node-agent declares depends_on on the AWG services. Without --no-deps,
  // compose recreates a dependency whose definition has drifted from the
  // running container -- a git pull that was never deployed turns a
  // zero-downtime capacity change into a tunnel outage. Peers survive either
  // way (the entrypoints regenerate only when awg0.conf is absent), but the
  // whole point of this script is that the tunnels do not drop.
  assert.doesNotMatch(code, /compose up[^\n]*\bawg[23]\b/);
  assert.doesNotMatch(code, /compose (stop|restart|down)/);
});

test("requires AWG 3.1 to be healthy, and AWG 2.0 only where it is enabled", async () => {
  // --no-deps means compose no longer waits for the data plane, so the script
  // asserts what depends_on used to assert. But awg2 is opt-in through
  // PROTOCOLS_ENABLED: demanding it unconditionally would refuse to run on
  // every 3.1-only node, which is exactly the defect that once made deploy.sh
  // unable to succeed on one.
  assert.match(code, /require_healthy amnezia-awg3/);
  assert.match(code, /if awg2_enabled; then\n\s*require_healthy amnezia-awg2/);
});

test("never touches persistent state", async () => {
  // Peer state lives in ./state/amnezia-awg{2,3} on the host. This script has
  // no business reading or writing it, and must never reach for the two
  // scripts that can move it.
  assert.doesNotMatch(code, /state\/amnezia-awg/);
  assert.doesNotMatch(code, /\brm -rf\b/);
  assert.doesNotMatch(code, /(backup|rollback)\.sh/);
});

test("runs the node's own preflight exactly once", async () => {
  // Two preflight runs on a small host fail the RAM gate: the first leaves a
  // throwaway container's memory held when the second re-reads MemAvailable.
  assert.equal(code.match(/preflight\.sh/g)?.length, 1);
});

test("restores the previous value when the agent does not come back", async () => {
  assert.match(code, /previous_max_peers=/);
  assert.match(code, /write_max_peers "\$previous_max_peers"/);
});

test("refuses an unvalidated capacity without an explicit --force", async () => {
  assert.match(code, /FORCE=0/);
  assert.match(code, /--force\) FORCE=1/);
  assert.match(code, /unvalidated/);
});

test("takes the deploy lock so it cannot race a deploy", async () => {
  assert.match(code, /acquire_lock/);
  assert.match(code, /release_lock/);
});

test("rejects a capacity outside 1..1000 before touching anything", async () => {
  // The bound is the /22 address pool, not a preference: past it the node
  // answers NO_FREE_IP and the panel keeps sending it keys.
  assert.match(code, /-le 1000/);
  assert.match(code, /-ge 1 \]/);
  // The validation block must come before the first write.
  assert.ok(
    code.indexOf("-le 1000") < code.indexOf("write_max_peers "),
    "capacity is validated before .env is rewritten",
  );
});

test("--help prints the header comment and nothing below it", async () => {
  const { stdout } = await promisify(execFile)("sh", [
    scriptUrl.pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    "--help",
  ]);
  assert.match(stdout, /Usage \(from the node's infra\/node directory\):/);
  assert.match(stdout, /--force/);
  assert.doesNotMatch(stdout, /^set -eu$/m);
  assert.doesNotMatch(stdout, /SCRIPT_DIR=/);
});
