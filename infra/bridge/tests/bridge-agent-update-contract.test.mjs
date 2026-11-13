import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

// The agent (services/bridge-agent), the host updater and the panel's contract
// (packages/contracts) are three separately built pieces that must agree on the
// update states and on the spool format. These tests pin the agreement.
const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

const stringArray = (source, name) => {
  const body = new RegExp(`${name}\\s*=\\s*\\[([^\\]]*)\\]`).exec(source)?.[1];
  assert.ok(body, `${name} not found`);
  return [...body.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
};

test("the agent's update states are exactly the panel's agent states", async () => {
  const agent = stringArray(await read("../../../services/bridge-agent/src/update.ts"), "UPDATE_AGENT_STATES");
  const panel = stringArray(await read("../../../packages/contracts/src/bridgeUpdateModel.ts"), "BRIDGE_AGENT_UPDATE_AGENT_STATES");
  assert.deepEqual(agent, panel);
});

test("the host updater writes only agent states and bounded, fixed error codes", async () => {
  const script = await read("../bridge-agent-update.sh");
  const agent = stringArray(await read("../../../services/bridge-agent/src/update.ts"), "UPDATE_AGENT_STATES");
  const written = [...script.matchAll(/^\s*(?:write_result|finish)\s+([a-z_]+)(?:\s+"?([A-Z][A-Z0-9_]*)"?)?/gm)];
  assert.ok(written.length > 10);
  for (const [, state, code] of written) {
    assert.ok(agent.includes(state), `unknown state ${state}`);
    if (code) assert.match(code, /^[A-Z][A-Z0-9_]{0,63}$/);
  }
  for (const [, code] of script.matchAll(/(?:rollback|GATE_CODE=)"?\s*"?([A-Z][A-Z0-9_]+)"?/g)) {
    assert.match(code, /^[A-Z][A-Z0-9_]{0,63}$/);
  }
  // The terminal set the updater uses equals the agent's.
  const terminal = /succeeded\|rolled_back\|rollback_failed\|failed\|expired\)/.test(script);
  assert.ok(terminal, "is_terminal lists the agent's terminal states");
});

test("the updater parses exactly the request fields the agent writes", async () => {
  const script = await read("../bridge-agent-update.sh");
  const parsed = [...script.matchAll(/json_field "\$body" ([A-Za-z]+)/g)].map((m) => m[1]).sort();
  assert.deepEqual(parsed, ["imageDigest", "imageRepository", "notAfter", "operationId"]);
  const agent = await read("../../../services/bridge-agent/src/update.ts");
  for (const field of parsed) assert.match(agent, new RegExp(`\\b${field}:`), field);
  // Results carry the intent back so the agent can detect a conflicting replay.
  for (const field of ["operationId", "imageRepository", "imageDigest", "notAfter", "state", "updatedAt", "errorCode"]) {
    assert.match(script, new RegExp(`\\\\"${field}\\\\":`), field);
  }
});

test("CI shellchecks every bridge script, the updater as bash", async () => {
  const ci = await read("../../../.github/workflows/ci.yml");
  assert.match(ci, /^\s+shellcheck -s bash infra\/bridge\/bridge-agent-update\.sh$/m);
  const scripts = (await readdir(fileURLToPath(new URL("..", import.meta.url)))).filter((name) => name.endsWith(".sh"));
  for (const name of scripts) assert.ok(ci.includes(`infra/bridge/${name}`), `${name} is not shellchecked in CI`);
});
