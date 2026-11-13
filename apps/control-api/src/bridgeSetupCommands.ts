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
const BRIDGE_SCRIPT = "/opt/amnezia-bridge/install-bridge.sh";
const FRPC_SCRIPT = "/opt/amnezia-panel-node/scripts/install-frpc.sh";

const command = (script: string, args: ReadonlyArray<[string, string | number]>, extra: string[] = []) =>
  ["sudo", "sh", script, ...args.flatMap(([flag, value]) => [flag, shellQuote(value)]), ...extra].join(" ");

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
