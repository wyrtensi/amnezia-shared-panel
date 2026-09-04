import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const entrypointUrl = new URL("../scripts/awg3-entrypoint.sh", import.meta.url);
const composeUrl = new URL("../compose.yaml", import.meta.url);

test("starts the pinned AWG3 userspace daemon without selecting the host kernel module", async () => {
  const script = await readFile(entrypointUrl, "utf8");

  const daemonStart = script.indexOf("amneziawg-go awg0");
  const configStrip = script.indexOf('awg-quick strip "$CONFIG_FILE"');
  const configApply = script.indexOf('awg setconf awg0 "$RUNTIME_CONFIG_FILE"');

  assert.ok(daemonStart >= 0, "the userspace daemon must be started explicitly");
  assert.ok(configStrip > daemonStart, "the persistent config must be stripped after daemon startup");
  assert.ok(configApply > configStrip, "the stripped config must be applied to the userspace interface");
  assert.doesNotMatch(script, /awg-quick up/);
});

test("configures and removes the AWG3 interface on its own subnet and port", async () => {
  const script = await readFile(entrypointUrl, "utf8");

  assert.match(script, /Address = 10\.90\.0\.1\/22/);
  assert.match(script, /ListenPort = 51890/);
  assert.match(script, /ip -4 address add 10\.90\.0\.1\/22 dev awg0/);
  assert.match(script, /ip link set mtu 1420 up dev awg0/);
  assert.match(script, /iptables -t nat -A POSTROUTING -s 10\.90\.0\.0\/22 -o eth0 -j MASQUERADE/);
  assert.match(script, /iptables -t nat -D POSTROUTING -s 10\.90\.0\.0\/22 -o eth0 -j MASQUERADE/);
  assert.match(script, /ip link delete dev awg0/);
});

test("generates AmneziaWG 3.1 obfuscation parameters", async () => {
  const script = await readFile(entrypointUrl, "utf8");

  // Header protection key marks the config as 3.1 and must be generated + verified
  assert.match(script, /HeaderProtectionKey = \$header_protection_key/);
  assert.match(script, /header_protection_key="\$\(awg genpsk\)"/);
  assert.match(script, /RandomTrailers = on/);
  assert.match(
    script,
    /Refusing to start: AWG3 config must define HeaderProtectionKey/,
  );

  // Header-protection nonce requires every S1-S4 padding to be at least 12 bytes
  for (const value of [/S1 = 15/, /S2 = 20/, /S3 = 20/, /S4 = 23/]) {
    assert.match(script, value);
  }
});

test("exposes the AWG3 container on UDP 51890 in the node stack", async () => {
  const compose = await readFile(composeUrl, "utf8");

  assert.match(compose, /container_name: amnezia-awg3/);
  assert.match(compose, /amneziavpn\/amneziawg-go:3\.1\.\d+@sha256:[0-9a-f]{64}/);
  assert.match(compose, /"51890:51890\/udp"/);
  // AWG 3.1 alone is the default shape; awg2 is opt-in through the same
  // variable, which is also what activates its compose profile.
  assert.match(compose, /PROTOCOLS_ENABLED: \$\{PROTOCOLS_ENABLED:-amneziawg3\}/);
});
