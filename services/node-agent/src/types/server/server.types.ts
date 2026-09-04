import { Protocol } from "@/types/shared";
import { ClientTableEntry } from "@/types/amnezia";

export type AmneziaBackupData = {
  wgConfig: string;
  presharedKey: string;
  serverPublicKey: string;
  clients: ClientTableEntry[];
};

export type XrayBackupData = {
  serverConfig: string;
  uuid: string;
  publicKey: string;
  privateKey: string;
  shortId: string;
};

export type ServerLoadDiskStats = {
  totalBytes: number;
  usedBytes: number;
  availableBytes: number;
  usedPercent: number;
};

export type ServerLoadNetworkStats = {
  rxBytes: number;
  txBytes: number;
};

export type ServerLoadDockerContainerStats = {
  name: string;
  cpuPercent: number | null;
  memUsageBytes: number | null;
  memLimitBytes: number | null;
  netRxBytes: number | null;
  netTxBytes: number | null;
  pids: number | null;
};

export type ServerLoadDockerStats = {
  containers: ServerLoadDockerContainerStats[];
};

/** One AWG interface as the agent sees it right now. */
export type AwgInterfaceState = {
  up: boolean;
  peers: number;
  listenPort: number | null;
};

export type ServerLoadPayload = {
  timestamp: string;
  uptimeSec: number;
  loadavg: [number, number, number];
  cpu: { cores: number };
  memory: {
    totalBytes: number;
    freeBytes: number;
    usedBytes: number;
    // What the kernel considers actually allocatable. Null on a host whose
    // /proc/meminfo could not be read; never substituted with freeBytes, which
    // is a much smaller and differently-meaning number.
    availableBytes: number | null;
  };
  // Null when the host reports no swap at all - which on a 1 GB node is itself
  // the finding, since swap is the first thing such a host should have.
  swap: { totalBytes: number; usedBytes: number | null } | null;
  agent: { pidsCurrent: number | null; pidsMax: number | null };
  awg: {
    amneziawg2: { up: boolean; peers: number } | null;
    amneziawg3: { up: boolean; peers: number } | null;
  };
  disk: ServerLoadDiskStats | null;
  network: ServerLoadNetworkStats | null;
  docker: ServerLoadDockerStats | null;
};

export type ServerBackupPayload = {
  generatedAt: string;
  serverId: string | null;
  protocols: Protocol[];
  amnezia?: AmneziaBackupData;
  amneziaWg2?: AmneziaBackupData;
  amneziaWg3?: AmneziaBackupData;
  xray?: XrayBackupData;
};

export type ServerStatusPayload = {
  id: string;
  region: string;
  weight: number;
  maxPeers: number;
  totalPeers: number;
  protocols: Protocol[];
  // SERVER_PUBLIC_HOST: the host written into every issued client config.
  publicHost: string;
  // The UDP ports this node actually listens on, read from the live interface
  // configs rather than from anything the panel assumes.
  listenPorts: number[];
  // What this agent can actually run as a service check. Reported so the panel
  // can tell "this node is too old for that rule" from "the service is down":
  // a check whose assertion type is absent here comes back as `error`, which
  // is "unknown" to a user, never "unavailable".
  checkCapabilities: {
    probeKinds: string[];
    assertionTypes: string[];
  };
};

// The lifecycle of an in-panel agent update, derived from the spool rather than
// from memory: the process answering a status call is usually not the process
// that made the request, because the update replaces it.
export type AgentUpdateState =
  | "idle"
  | "requested"
  | "running"
  | "succeeded"
  | "failed";

export type AgentUpdateStatus = {
  state: AgentUpdateState;
  image: string | null;
  log: string;
  updatedAt: string | null;
  message: string | null;
};

// The lifecycle of an in-panel capacity change. Same shape and same reasoning as
// AgentUpdateState: applying a change recreates the agent container, so the state
// lives in the spool on the host rather than in this process's memory.
export type CapacityState =
  | "idle"
  | "requested"
  | "running"
  | "succeeded"
  | "failed";

export type CapacityStatus = {
  state: CapacityState;
  requestedMaxPeers: number | null;
  log: string;
  updatedAt: string | null;
  message: string | null;
};
