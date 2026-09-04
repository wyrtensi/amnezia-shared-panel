import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const read = async (name) =>
  (await readFile(new URL(`../${name}`, import.meta.url), "utf8")).replace(
    /\r\n/g,
    "\n",
  );

const stripComments = (text) =>
  text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");

const compose = await read("compose.yaml");
const deploy = stripComments(await read("scripts/deploy.sh"));
const rollback = stripComments(await read("scripts/rollback.sh"));
const common = stripComments(await read("scripts/common.sh"));
const preflight = stripComments(await read("scripts/preflight.sh"));

test("the agent no longer requires awg2 to exist", () => {
  // AWG 3.1 alone is the default node shape now. While node-agent declared
  // depends_on awg2, a 3.1-only node could not start its agent at all without
  // someone bringing up a protocol it does not serve - which is exactly what
  // had to be done by hand on the panel host.
  const dependsOn = compose.slice(
    compose.indexOf("  node-agent:"),
    compose.indexOf("    entrypoint:", compose.indexOf("  node-agent:")),
  );

  assert.doesNotMatch(dependsOn, /awg2:/, "node-agent must not depend on awg2");
  assert.match(dependsOn, /awg3:\s*\n\s*condition: service_healthy/);
});

test("awg2 is behind a compose profile, so it is opt-in", () => {
  const awg2 = compose.slice(
    compose.indexOf("  awg2:"),
    compose.indexOf("  awg3:"),
  );

  assert.match(awg2, /profiles:\s*\n\s*- awg2/);
});

test("one switch decides it, not two that can disagree", () => {
  // The profile follows PROTOCOLS_ENABLED. A separate AWG2_ENABLED flag would
  // be a second source of truth, and the failure mode of the two disagreeing
  // is a node whose agent manages a protocol that is not running.
  assert.match(common, /awg2_enabled\(\)/);
  assert.match(common, /PROTOCOLS_ENABLED/);
  assert.match(common, /--profile awg2/);
  assert.doesNotMatch(common, /AWG2_ENABLED/);
});

test("compose is invoked with the profile everywhere or nowhere", () => {
  // has_service, the health gates and `up` must all see the same set of
  // services. A profile passed to `up` but not to `config --services` would
  // deploy awg2 and then never health-gate it.
  assert.match(common, /compose\(\)/);
  const invocations = [...deploy.matchAll(/docker compose /g)];
  assert.equal(
    invocations.length,
    0,
    "deploy.sh must go through the compose() helper, never call docker compose directly",
  );
});

test("no script removes orphans any more", () => {
  // A service whose profile is disabled still belongs to this compose project,
  // so --remove-orphans is entitled to delete its container - including a live
  // awg2 carrying peers. The clean-up it buys is not worth that.
  for (const [name, script] of [
    ["deploy.sh", deploy],
    ["rollback.sh", rollback],
  ]) {
    assert.doesNotMatch(script, /--remove-orphans/, `${name} must not remove orphans`);
  }
});

test("the awg2 guard only fires for an awg2 that is ours", () => {
  // Two of our hosts run an unlabelled `amnezia-awg2` from somebody else's
  // AmneziaVPN install - one of them carrying 41 peers. Those are precisely
  // the nodes where the profile must stay OFF, so a guard that keys on the
  // container name alone refuses to deploy exactly where it matters most.
  assert.match(
    preflight,
    /com\.docker\.compose\.project/,
    "the guard must check ownership, not just the name",
  );
  assert.match(preflight, /awg2_is_ours/);
});

test("preflight refuses to silently drop a running awg2", () => {
  // The upgrade hazard: an existing node runs awg2 with live peers, its .env
  // predates PROTOCOLS_ENABLED, and the new default is awg3-only. Deploying
  // that would stop awg2 and drop every legacy peer without saying so.
  assert.match(preflight, /awg2_enabled/);
  assert.match(
    preflight,
    /container_is_running amnezia-awg2/,
    "preflight must notice a running awg2",
  );
  assert.match(preflight, /PROTOCOLS_ENABLED/);
});

test("the agent is told which protocols it serves, rather than assuming both", () => {
  assert.match(
    compose,
    /PROTOCOLS_ENABLED: \$\{PROTOCOLS_ENABLED:-amneziawg3\}/,
    "the default is AWG 3.1 only",
  );
});
