import {
  deriveWytunnelTransportPort,
  normalizeWytunnelTransportConfig,
  type BridgeRouteTransport,
  type BridgeSetupCommands,
  type RouteSetupCommands,
  type WytunnelTransportConfig,
} from "@amnezia/contracts";

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
const BRIDGE_SCRIPT = "/opt/amnezia-bridge/install-bridge.sh";
const BRIDGE_WYTUNNEL_SCRIPT = "/opt/amnezia-bridge/scripts/install-wytunnel-bridge.sh";
const BRIDGE_TOGGLE_FRPS_SCRIPT = "/opt/amnezia-bridge/scripts/toggle-frps.sh";
const FRPC_SCRIPT = "/opt/amnezia-panel-node/scripts/install-frpc.sh";
const NODE_WYTUNNEL_SCRIPT = "/opt/amnezia-panel-node/scripts/install-wytunnel-node.sh";

const command = (
  script: string,
  args: ReadonlyArray<[string, string | number]>,
  extra: string[] = [],
  shell: "sh" | "bash" = "sh",
) =>
  ["sudo", shell, script, ...args.flatMap(([flag, value]) => [flag, shellQuote(value)]), ...extra].join(" ");

export type BridgeSetupInput = {
  id: string;
  controlTcpPort: number;
  udpPortStart: number;
  udpPortEnd: number;
};

/**
 * `agentImage` is the digest-pinned `<approved repository>@sha256:<digest>`
 * the panel resolved (null when none is available); with it the installer also
 * installs the bridge-agent, without it the installer exits 60 after frps. The
 * reference is public registry metadata, not a secret.
 */
export const bridgeSetupCommands = (
  bridge: BridgeSetupInput,
  agentImage: string | null = null,
): BridgeSetupCommands => {
  const args: Array<[string, string | number]> = [
    ["--bridge-id", bridge.id],
    ["--control-port", bridge.controlTcpPort],
    ["--udp-start", bridge.udpPortStart],
    ["--udp-end", bridge.udpPortEnd],
    // The repository is passed too, so the installer enforces and the pin
    // records the repository the panel approved, not one inferred from the image.
    ...(agentImage
      ? ([
          ["--agent-image", agentImage],
          ["--agent-repository", agentImage.slice(0, agentImage.indexOf("@"))],
        ] as Array<[string, string]>)
      : []),
  ];
  return {
    install: command(BRIDGE_SCRIPT, args),
    dryRun: command(BRIDGE_SCRIPT, args, ["--dry-run"]),
    agentImage,
  };
};

export type RouteSetupInput = {
  id: string;
  bridgeId: string;
  publicUdpPort: number;
  bridgePublicIpv4: string;
  bridgeControlTcpPort: number;
  udpPortStart?: number;
  nodePublicIp?: string | null;
  transport?: BridgeRouteTransport;
  transportPort?: number | null;
  transportConfig?: Partial<WytunnelTransportConfig> | null;
  bridgeFrpsEnabled?: boolean;
};

export const routeSetupCommands = (route: RouteSetupInput): RouteSetupCommands => {
  if (route.transport === "wytunnel") {
    const cfg = normalizeWytunnelTransportConfig(route.transportConfig);
    const transportPort =
      route.transportPort ??
      deriveWytunnelTransportPort(route.publicUdpPort, route.udpPortStart);
    const slot = Math.max(0, route.publicUdpPort - (route.udpPortStart ?? 41000));
    const fecValue = cfg.fec ? `${cfg.fec.k}:${cfg.fec.m}` : null;
    const nodeTargetIp = route.nodePublicIp?.trim() || "<NODE_PUBLIC_IP>";

    const nodeArgs: Array<[string, string | number]> = [
      ["--route-id", route.id],
      ["--bridge-ip", route.bridgePublicIpv4],
      ["--transport-port", transportPort],
      ["--slot", slot],
      ["--keepalive", cfg.keepaliveSec],
      ["--handshake-mode", cfg.handshakeMode],
    ];
    if (fecValue) nodeArgs.push(["--fec", fecValue]);
    const nodeFlags: string[] = [
      cfg.poolSize > 0 ? "--pool-mode" : "--direct-mode",
      ...(!cfg.ebpfEnabled ? ["--no-ebpf"] : []),
    ];

    const bridgeArgs: Array<[string, string | number]> = [
      ["--route-id", route.id],
      ["--bridge-id", route.bridgeId],
      ["--public-port", route.publicUdpPort],
      ["--node-ip", nodeTargetIp],
      ["--transport-port", transportPort],
      ["--slot", slot],
      ["--pool-size", cfg.poolSize],
      ["--pool-rotate-interval", cfg.poolRotateIntervalSec],
      ["--pool-rotate-drain", cfg.poolRotateDrainSec],
      ["--keepalive", cfg.keepaliveSec],
      ["--handshake-mode", cfg.handshakeMode],
    ];
    if (fecValue) bridgeArgs.push(["--fec", fecValue]);
    const bridgeFlags: string[] = [
      ...(!cfg.ebpfEnabled ? ["--no-ebpf"] : []),
      ...(route.bridgeFrpsEnabled === false ? ["--disable-frps"] : []),
    ];

    return {
      install: command(NODE_WYTUNNEL_SCRIPT, nodeArgs, nodeFlags, "bash"),
      dryRun: command(NODE_WYTUNNEL_SCRIPT, nodeArgs, [...nodeFlags, "--dry-run"], "bash"),
      remove: command(NODE_WYTUNNEL_SCRIPT, [["--route-id", route.id]], ["--remove"], "bash"),
      bridgeInstall: command(BRIDGE_WYTUNNEL_SCRIPT, bridgeArgs, bridgeFlags, "bash"),
      bridgeDryRun: command(
        BRIDGE_WYTUNNEL_SCRIPT,
        bridgeArgs,
        [...bridgeFlags, "--dry-run"],
        "bash",
      ),
      bridgeRemove: command(BRIDGE_WYTUNNEL_SCRIPT, [["--route-id", route.id]], ["--remove"], "bash"),
      disableFrpc: `sudo systemctl disable --now ${shellQuote(`amnezia-frpc@${route.id}.service`)}`,
      disableFrps: command(BRIDGE_TOGGLE_FRPS_SCRIPT, [], ["--disable"], "bash"),
    };
  }

  const bridgeArgs: Array<[string, string | number]> = [
    ["--bridge-id", route.bridgeId],
    ["--bridge-ip", route.bridgePublicIpv4],
    ["--control-port", route.bridgeControlTcpPort],
  ];
  const args: Array<[string, string | number]> = [
    ["--route-id", route.id],
    ...bridgeArgs,
    ["--public-port", route.publicUdpPort],
  ];
  return {
    install: command(FRPC_SCRIPT, args),
    dryRun: command(FRPC_SCRIPT, args, ["--dry-run"]),
    checkTls: command(FRPC_SCRIPT, bridgeArgs, ["--check-tls"]),
    remove: command(FRPC_SCRIPT, [["--route-id", route.id]], ["--remove"]),
  };
};
