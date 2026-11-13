import type { BridgeSetupCommands, RouteSetupCommands } from "@amnezia/contracts";

/**
 * Host setup commands the operator runs on a bridge or node host. They are
 * built only from non-secret registry fields; the bridge token and CA come from
 * protected files on the host (see infra/bridge/README.md), never from here.
 * The local target overrides of install-frpc.sh (`--local-udp-port <udp>`,
 * `--local-ip <ipv4>`) are left out on purpose: the script detects the Docker
 * mapping itself. Append them to the install command only when its detection
 * asks for them (for example a bind to a specific IPv4 address).
 */

const SAFE_WORD = /^[A-Za-z0-9._:/=@%+-]+$/;

/** POSIX single-quote an argument unless it is plainly safe. */
export const shellQuote = (value: string | number): string => {
  const text = String(value);
  return SAFE_WORD.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`;
};

// Where the scripts live on the hosts. Nodes get infra/node at this path from
// scripts/add-node.sh (re-run it to sync a new script to an existing node); the
// bridge has no deployer, so infra/bridge/ is copied to /opt/amnezia-bridge/ by
// hand (see infra/bridge/README.md).
const FRPS_SCRIPT = "/opt/amnezia-bridge/install-frps.sh";
const FRPC_SCRIPT = "/opt/amnezia-panel-node/scripts/install-frpc.sh";

const command = (script: string, args: ReadonlyArray<[string, string | number]>, extra: string[] = []) =>
  ["sudo", "sh", script, ...args.flatMap(([flag, value]) => [flag, shellQuote(value)]), ...extra].join(" ");

export type BridgeSetupInput = {
  id: string;
  controlTcpPort: number;
  udpPortStart: number;
  udpPortEnd: number;
};

export const bridgeSetupCommands = (bridge: BridgeSetupInput): BridgeSetupCommands => {
  const args: Array<[string, string | number]> = [
    ["--bridge-id", bridge.id],
    ["--control-port", bridge.controlTcpPort],
    ["--udp-start", bridge.udpPortStart],
    ["--udp-end", bridge.udpPortEnd],
  ];
  return {
    install: command(FRPS_SCRIPT, args),
    dryRun: command(FRPS_SCRIPT, args, ["--dry-run"]),
  };
};

export type RouteSetupInput = {
  id: string;
  publicUdpPort: number;
  bridgePublicIpv4: string;
  bridgeControlTcpPort: number;
};

export const routeSetupCommands = (route: RouteSetupInput): RouteSetupCommands => {
  const args: Array<[string, string | number]> = [
    ["--route-id", route.id],
    ["--bridge-ip", route.bridgePublicIpv4],
    ["--control-port", route.bridgeControlTcpPort],
    ["--public-port", route.publicUdpPort],
  ];
  return {
    install: command(FRPC_SCRIPT, args),
    dryRun: command(FRPC_SCRIPT, args, ["--dry-run"]),
    remove: command(FRPC_SCRIPT, [["--route-id", route.id]], ["--remove"]),
  };
};
