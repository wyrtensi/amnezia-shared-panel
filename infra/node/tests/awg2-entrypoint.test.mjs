import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrypointUrl = new URL("../scripts/awg2-entrypoint.sh", import.meta.url);
const composeUrl = new URL("../compose.yaml", import.meta.url);
const preflightUrl = new URL("../scripts/preflight.sh", import.meta.url);
const readmeUrl = new URL("../README.md", import.meta.url);

test("starts the pinned AWG2 userspace daemon without selecting the host kernel module", async () => {
  const script = await readFile(entrypointUrl, "utf8");

  const daemonStart = script.indexOf("amneziawg-go awg0");
  const configStrip = script.indexOf('awg-quick strip "$CONFIG_FILE"');
  const configApply = script.indexOf('awg setconf awg0 "$RUNTIME_CONFIG_FILE"');

  assert.ok(daemonStart >= 0, "the userspace daemon must be started explicitly");
  assert.ok(configStrip > daemonStart, "the persistent config must be stripped after daemon startup");
  assert.ok(configApply > configStrip, "the stripped config must be applied to the userspace interface");
  assert.doesNotMatch(script, /awg-quick up/);
});

test("configures and removes the userspace interface symmetrically", async () => {
  const script = await readFile(entrypointUrl, "utf8");

  assert.match(script, /ip -4 address add 10\.89\.0\.1\/22 dev awg0/);
  assert.match(script, /ip link set mtu 1420 up dev awg0/);
  assert.match(script, /iptables -A FORWARD -i awg0 -j ACCEPT/);
  assert.match(script, /iptables -t nat -A POSTROUTING -s 10\.89\.0\.0\/22 -o eth0 -j MASQUERADE/);
  assert.match(script, /iptables -t nat -D POSTROUTING -s 10\.89\.0\.0\/22 -o eth0 -j MASQUERADE/);
  assert.match(script, /ip link delete dev awg0/);
});

test("keeps the file-backed API secret readable only by root-group services", async () => {
  const [compose, preflight, readme] = await Promise.all([
    readFile(composeUrl, "utf8"),
    readFile(preflightUrl, "utf8"),
    readFile(readmeUrl, "utf8"),
  ]);

  assert.match(compose, /node-agent:[\s\S]*?user:\s*["']10001:0["']/);
  assert.match(preflight, /API key secret permissions must be 0640/);
  assert.match(readme, /chmod 640 secrets\/node-agent-api-key/);
});
