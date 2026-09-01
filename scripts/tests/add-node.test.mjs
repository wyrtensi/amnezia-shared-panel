import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../add-node.sh", import.meta.url);
const exampleUrl = new URL("../add-node.env.example", import.meta.url);
const gitignoreUrl = new URL("../../.gitignore", import.meta.url);
const deployUrl = new URL("../../infra/node/scripts/deploy.sh", import.meta.url);

const script = await readFile(scriptUrl, "utf8");
const example = await readFile(exampleUrl, "utf8");
const deploy = await readFile(deployUrl, "utf8");

test("copies infra/node with root ownership", async () => {
  // A plain `tar -c` carries the invoking uid, which leaves the mode-0700 AWG
  // entrypoints unreadable inside the containers and crash-loops both of them.
  const create = script.slice(script.indexOf("tar -C"), script.indexOf("| node_ssh"));
  assert.match(create, /--owner=0/);
  assert.match(create, /--group=0/);
  assert.match(create, /--numeric-owner/);
  assert.match(script, /chown -R root:root/);
});

test("pins NODE_AGENT_IMAGE to the id the receiving host reported", async () => {
  // `docker save | docker load` re-encodes the config on newer engines, so the
  // node's id differs from the source host's; pinning the source id makes
  // preflight fail with the image "not present locally".
  assert.match(script, /loaded_id="\$\(node_ssh "docker image inspect --format '\{\{\.Id\}\}'/);
  assert.match(script, /sed -i 's\|\^NODE_AGENT_IMAGE=\.\*\|NODE_AGENT_IMAGE=\$\{loaded_id\}\|'/);
});

test("restores 0600 state permissions instead of relaxing the preflight gate", async () => {
  const step = script.slice(script.indexOf("[5/7]"), script.indexOf("[6/7]"));
  assert.match(step, /find '\$NODE_DIR\/state' -type f -exec chmod 600/);
  // Order matters, so compare the commands only — the comments above them name
  // the same scripts and would otherwise satisfy the assertions on their own.
  const commands = step
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n");
  assert.ok(
    commands.indexOf("chmod 600") < commands.indexOf("deploy.sh"),
    "permissions must be repaired before the gate runs, not instead of it",
  );
  // deploy.sh runs preflight.sh itself, so add-node.sh must NOT invoke it
  // separately: the extra run leaves a throwaway container's memory held when
  // deploy re-checks the RAM gate, which fails the gate on a small node.
  assert.doesNotMatch(commands, /sh scripts\/preflight\.sh/);
  assert.match(deploy, /^sh "\$SCRIPT_DIR\/preflight\.sh"$/m);
});

test("binds the tunnel on a private address and survives a panel reboot", async () => {
  const step = script.slice(script.indexOf("[6/7]"), script.indexOf("[7/7]"));
  assert.match(step, /-L \$\{BIND\}:\$\{PORT\}:127\.0\.0\.1:4001/);
  assert.match(step, /AUTOSSH_GATETIME=0/);
  assert.match(step, /systemctl enable --now/);
  // The default bind is the Docker bridge gateway, never a public interface.
  assert.match(script, /TUNNEL_BIND="\$\{TUNNEL_BIND:-172\.17\.0\.1\}"/);
});

test("holds no deployment-specific values", async () => {
  // Everything site-specific comes from scripts/add-node.env; a literal address
  // or a personal key path in the script would leak one deployment into the repo.
  const ipv4 = /\b(?!127\.0\.0\.1|0\.0\.0\.0|172\.17\.0\.1)\d{1,3}(\.\d{1,3}){3}\b/g;
  assert.deepEqual(script.match(ipv4) ?? [], []);
  for (const source of [script, example]) {
    assert.doesNotMatch(source, /\.popstas\.pro/);
  }
  // Required settings must fail loudly rather than fall back to a guess.
  assert.match(script, /: "\$\{PANEL_SSH:\?set PANEL_SSH in \$CONFIG\}"/);
});

test("the example config documents every setting the script requires", async () => {
  for (const key of [
    "PANEL_SSH",
    "PANEL_COMPOSE_DIR",
    "PANEL_NODE_KEY",
    "PANEL_CONTROL_API_SERVICE",
    "NODE_AGENT_IMAGE_SOURCE",
    "TUNNEL_BIND",
    "TUNNEL_PORT_BASE",
    "NODE_DIR",
  ]) {
    assert.match(example, new RegExp(`^${key}=`, "m"), `${key} is missing from the example`);
  }
});

test("the real config is git-ignored", async () => {
  const gitignore = await readFile(gitignoreUrl, "utf8");
  assert.match(gitignore, /^\/scripts\/add-node\.env$/m);
  assert.doesNotMatch(gitignore, /^\/scripts\/add-node\.env\.example$/m);
});

test("never prints the node-agent API key", async () => {
  // The key is read on the panel host and piped straight into the CLI; it must
  // not reach this workstation, the script's output, or a shell trace.
  assert.doesNotMatch(script, /echo .*node-agent-api-key/);
  assert.doesNotMatch(script, /set -x/);
  const register = script.slice(script.indexOf("[7/7]"));
  // -n is load-bearing: this block reaches bash on stdin, so without it the ssh
  // drains the rest of the heredoc and the node-add below never runs -- the step
  // prints nothing and exits 0 while registering no node.
  assert.match(register, /key="\$\(ssh -n -i "\$NODE_KEY"/);
  assert.match(register, /--api-key="\$key"/);
});

const runShellFunction = async (name, ...args) => {
  const start = script.indexOf(`${name}() {`);
  assert.notEqual(start, -1, `${name} must be defined in add-node.sh`);
  const end = script.indexOf("\n}\n", start);
  assert.notEqual(end, -1, `${name} must be a top-level function`);
  const body = script.slice(start, end + 3);
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("bash", [
    "-c",
    `${body}\n${name} ${args.map((value) => `'${value}'`).join(" ")}`,
  ]);
  return stdout.trim();
};

test("derives node capacity from the host's memory, capped at 500 peers", async () => {
  // The preflight RAM gate asks for 358400 KiB * peers / 500 of MemAvailable,
  // so the recommendation inverts it: whatever the host can actually carry,
  // never above the 500-peer ceiling the panel and the agent are validated for.
  assert.equal(await runShellFunction("recommended_max_peers", 358400), "500");
  assert.equal(await runShellFunction("recommended_max_peers", 4194304), "500");
  assert.equal(await runShellFunction("recommended_max_peers", 196608), "274");
  // Below the gate's 192 MiB floor no capacity passes, so the honest answer is
  // "none" rather than a number the deploy would then refuse.
  assert.equal(await runShellFunction("recommended_max_peers", 196607), "0");
  assert.equal(await runShellFunction("recommended_max_peers", 100000), "0");
});

test("uses that recommendation only when no capacity was asked for", async () => {
  // An explicit --max-peers or NODE_MAX_PEERS is an operator decision and must
  // win over anything derived from a memory reading taken at one instant.
  assert.match(script, /MAX_PEERS="\$\{MAX_PEERS:-\$\{NODE_MAX_PEERS:-\}\}"/);
  const step = script.slice(script.indexOf("[1/7]"), script.indexOf("[2/7]"));
  assert.match(step, /recommended_max_peers/);
  assert.match(step, /MemAvailable/);
});

test("--help prints the header comment and nothing below it", async () => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { stdout } = await promisify(execFile)("bash", [
    new URL("../add-node.sh", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
    "--help",
  ]);

  assert.match(stdout, /Usage:/);
  assert.match(stdout, /--dry-run/);
  // A line-numbered `sed` range drifts every time the header grows a line, and
  // then --help starts printing the script's own code back at the operator.
  assert.doesNotMatch(stdout, /^set -euo pipefail$/m);
  assert.doesNotMatch(stdout, /REPO_ROOT=/);
});
