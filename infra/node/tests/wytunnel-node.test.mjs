import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const nodeScript = fileURLToPath(new URL("../scripts/install-wytunnel-node.sh", import.meta.url));
const ROUTE_ID = "11111111-2222-4333-8444-555555555555";

test("install-wytunnel-node.sh dry-run derives slot, bridge allowlist, pool-mode, and disables inactive frpc", () => {
  const out = execFileSync(
    "bash",
    [
      nodeScript,
      "--route-id", ROUTE_ID,
      "--bridge-ip", "203.0.113.50",
      "--node-primary-ip", "198.51.100.20",
      "--remote-port", "41004",
      "--pool-mode",
      "--wan-if", "eth0",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.match(out, /allow_bridge_ip\s*=\s*203\.0\.113\.50/);
  assert.match(out, /listen_faketcp\s*=\s*198\.51\.100\.20:14104\/tcp/);
  assert.match(out, /tun\s*=\s*pts-4 \(10\.251\.4\.1 <-> 10\.251\.4\.2\)/);
  assert.match(out, /--pool-mode/);
  assert.match(out, /disable_frpc\s*=\s*1/);
});

test("install-wytunnel-node.sh derives distinct TUN slots from --transport-port across multiple bridges", () => {
  const out = execFileSync(
    "bash",
    [
      nodeScript,
      "--route-id", ROUTE_ID,
      "--bridge-ip", "203.0.113.51",
      "--node-primary-ip", "198.51.100.20",
      "--remote-port", "41004",
      "--transport-port", "14154",
      "--pool-mode",
      "--wan-if", "eth0",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.match(out, /listen_faketcp\s*=\s*198\.51\.100\.20:14154\/tcp/);
  assert.match(out, /tun\s*=\s*pts-54 \(10\.251\.54\.1 <-> 10\.251\.54\.2\)/);
});

test("install-wytunnel-node.sh --remove --dry-run plans clean unit removal", () => {
  const out = execFileSync(
    "bash",
    [nodeScript, "--route-id", ROUTE_ID, "--remove", "--dry-run"],
    { encoding: "utf8" },
  );
  assert.match(out, /systemctl disable --now amnezia-wytunnel-server@11111111-2222-4333-8444-555555555555\.service/);
});
