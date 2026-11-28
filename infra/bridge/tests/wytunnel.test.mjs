import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

const bridgeScript = fileURLToPath(new URL("../install-wytunnel-bridge.sh", import.meta.url));
const toggleFrpsScript = fileURLToPath(new URL("../toggle-frps.sh", import.meta.url));
const ROUTE_ID = "11111111-2222-4333-8444-555555555555";

test("install-wytunnel-bridge.sh dry-run derives slot, pool, rotation, and disable-frps", () => {
  const out = execFileSync(
    "bash",
    [
      bridgeScript,
      "--route-id", ROUTE_ID,
      "--node-ip", "198.51.100.20",
      "--remote-port", "41004",
      "--pool-size", "10",
      "--pool-rotate-interval", "2700",
      "--fec", "20:1",
      "--disable-frps",
      "--wan-if", "eth0",
      "--dry-run",
    ],
    { encoding: "utf8" },
  );
  assert.match(out, /target_faketcp\s*=\s*198\.51\.100\.20:14104/);
  assert.match(out, /tun\s*=\s*ptc-4 \(10\.250\.4\.1 <-> 10\.250\.4\.2\)/);
  assert.match(out, /pool_size\s*=\s*10/);
  assert.match(out, /--pool-size 10 --pool-rotate-interval 2700 --pool-rotate-drain 5/);
  assert.match(out, /--fec 20:1/);
  assert.match(out, /disable_frps\s*=\s*1/);
});

test("install-wytunnel-bridge.sh rejects invalid route UUID", () => {
  assert.throws(() =>
    execFileSync("bash", [bridgeScript, "--route-id", "not-a-uuid", "--dry-run"], {
      stdio: "pipe",
    }),
  );
});

test("toggle-frps.sh dry-run prints disable and enable plans", () => {
  const off = execFileSync("bash", [toggleFrpsScript, "--disable", "--dry-run"], { encoding: "utf8" });
  assert.match(off, /systemctl disable --now amnezia-frps\.service/);
  assert.match(off, /BRIDGE_FRPS_ENABLED=false/);

  const on = execFileSync("bash", [toggleFrpsScript, "--enable", "--dry-run"], { encoding: "utf8" });
  assert.match(on, /systemctl enable --now amnezia-frps\.service/);
  assert.match(on, /BRIDGE_FRPS_ENABLED=true/);
});
