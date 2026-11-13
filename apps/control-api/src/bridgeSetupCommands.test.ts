import { describe, expect, it } from "vitest";
import { bridgeSetupCommands, routeSetupCommands, shellQuote } from "./bridgeSetupCommands.js";

const BRIDGE_ID = "3f1c2a40-7b6d-4d2e-8a11-0c9e5b7d1a22";
const ROUTE_ID = "0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";

describe("bridge setup commands", () => {
  it("builds the frps install and dry-run commands from registry fields only", () => {
    const commands = bridgeSetupCommands({
      id: BRIDGE_ID,
      controlTcpPort: 7000,
      udpPortStart: 41000,
      udpPortEnd: 41031,
    });
    expect(commands).toEqual({
      install: `sudo sh /opt/amnezia-bridge/install-bridge.sh --bridge-id ${BRIDGE_ID} --control-port 7000 --udp-start 41000 --udp-end 41031`,
      dryRun: `sudo sh /opt/amnezia-bridge/install-bridge.sh --bridge-id ${BRIDGE_ID} --control-port 7000 --udp-start 41000 --udp-end 41031 --dry-run`,
      agentImage: null,
    });
    expect(commands).not.toHaveProperty("remove");
  });

  it("appends the digest-pinned agent image to both commands, before --dry-run", () => {
    const image = `ghcr.io/owner/repo/bridge-agent@sha256:${"a".repeat(64)}`;
    const commands = bridgeSetupCommands(
      { id: BRIDGE_ID, controlTcpPort: 7000, udpPortStart: 41000, udpPortEnd: 41031 },
      image,
    );
    const base = `sudo sh /opt/amnezia-bridge/install-bridge.sh --bridge-id ${BRIDGE_ID} --control-port 7000 --udp-start 41000 --udp-end 41031 --agent-image ${image} --agent-repository ghcr.io/owner/repo/bridge-agent`;
    expect(commands).toEqual({ install: base, dryRun: `${base} --dry-run`, agentImage: image });
  });

  it("builds the frpc commands without local overrides and a remove that needs only the route id", () => {
    const commands = routeSetupCommands({
      id: ROUTE_ID,
      publicUdpPort: 41005,
      bridgePublicIpv4: "198.51.100.7",
      bridgeControlTcpPort: 7000,
    });
    const base = `sudo sh /opt/amnezia-panel-node/scripts/install-frpc.sh --route-id ${ROUTE_ID} --bridge-ip 198.51.100.7 --control-port 7000 --public-port 41005`;
    expect(commands).toEqual({
      install: base,
      dryRun: `${base} --dry-run`,
      remove: `sudo sh /opt/amnezia-panel-node/scripts/install-frpc.sh --route-id ${ROUTE_ID} --remove`,
    });
    for (const text of Object.values(commands)) {
      expect(text).not.toMatch(/--local-(ip|udp-port)|token|password|secret|\.crt|\.key/i);
    }
  });

  it("quotes any argument that is not plainly safe", () => {
    expect(shellQuote("41000")).toBe("41000");
    expect(shellQuote("198.51.100.7")).toBe("198.51.100.7");
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("x; rm -rf /")).toBe("'x; rm -rf /'");
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("$(id)")).toBe("'$(id)'");
    expect(shellQuote("")).toBe("''");
  });

  it("quotes hostile values instead of letting them reach the shell", () => {
    const commands = routeSetupCommands({
      id: ROUTE_ID,
      publicUdpPort: 41005,
      bridgePublicIpv4: "1.2.3.4; curl evil",
      bridgeControlTcpPort: 7000,
    });
    expect(commands.install).toContain("--bridge-ip '1.2.3.4; curl evil'");
  });
});
