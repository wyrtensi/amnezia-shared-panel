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
  // One number for the interface and for S4's share of the MTU budget. They
  // were two once - interface 1420, budget computed for 1376 - which put up to
  // 1525 bytes on a 1500-byte path.
  assert.match(script, /ip link set mtu "\$IFACE_MTU" up dev awg0/);
  assert.match(script, /IFACE_MTU="\$\{AWG3_TUNNEL_MTU:-1420\}"/);
  assert.match(script, /GEOMETRY_SCRIPT" "\$IFACE_MTU"/);
  assert.match(script, /iptables -t nat -A POSTROUTING -s 10\.90\.0\.0\/22 -o eth0 -j MASQUERADE/);
  assert.match(script, /iptables -t nat -D POSTROUTING -s 10\.90\.0\.0\/22 -o eth0 -j MASQUERADE/);
  assert.match(script, /ip link delete dev awg0/);
});

test("generates AmneziaWG 3.1 obfuscation parameters", async () => {
  const script = await readFile(entrypointUrl, "utf8");

  // Header protection key marks the config as 3.1 and must be generated + verified
  assert.match(script, /HeaderProtectionKey = \$header_protection_key/);
  assert.match(script, /header_protection_key="\$\(awg genpsk\)"/);
  // RandomTrailers is emitted by the geometry generator now. It used to be
  // written here as well, and the two tools disagreed about which copy wins.
  assert.doesNotMatch(script, /^RandomTrailers = /m);
  assert.match(
    script,
    /Refusing to start: AWG3 config must define HeaderProtectionKey/,
  );

  // The geometry itself is drawn per node now, so there are no S values to
  // assert here. The nonce floor, the header distinctness and the junk-range
  // invariant are enforced and tested in awg3-geometry.sh instead — a constant
  // here would put the whole fleet back on one fingerprint.
  assert.match(script, /awg3-geometry\.sh/);
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
