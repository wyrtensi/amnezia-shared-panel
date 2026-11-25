export type EgressMode = "masquerade" | "routed";

export type EgressState =
  | "masquerade_ready"
  | "routed_active"
  | "conflict"
  | "degraded";

export type ExitHostState =
  | "active"
  | "pending"
  | "missing_ip"
  | "gateway_error"
  | "disabled";

export type DesiredExit = {
  id: string;
  ipv4: string;
  interfaceName?: string;
  gatewayIpv4?: string;
  routingTableId?: number;
  dnsPrimary: string;
  dnsSecondary?: string;
  amneziaDnsDnat: boolean;
  enforceDnsDnat: boolean;
  enabled: boolean;
};

export type DesiredPeer = {
  tunnelIpv4: string;
  exitIp: string;
  dnsPrimary?: string;
  amneziaDnsDnat: boolean;
  enforceDnsDnat: boolean;
  routingTableId?: number;
  enabled: boolean;
};

export type DesiredEntryMark = {
  entryIpv4: string;
  routingTableId: number;
};

export type DesiredState = {
  schemaVersion: number;
  blockSmtp: boolean;
  isolatePrivate: boolean;
  exits: DesiredExit[];
  peers: DesiredPeer[];
  entryMarks?: DesiredEntryMark[];
};

export type DetectedIPv4 = {
  ipv4: string;
  cidr: string;
  interfaceName: string;
  detectedGatewayIpv4?: string;
  detectedRuleTable?: number;
};

export type ExitStatus = {
  ipv4: string;
  hostState: ExitHostState;
  detail?: string;
  observedSubnetCidr?: string;
  detectedGatewayIpv4?: string;
  txBytes: number;
  txPackets: number;
};

export type HostNetworkReport = {
  daemonVersion: string;
  observedMode: EgressMode;
  egressState: EgressState;
  detail?: string;
  bridgeName: string;
  bridgePresent: boolean;
  awg3ContainerIpv4?: string;
  tunnelSubnetConflict: boolean;
  ipv4Addresses: DetectedIPv4[];
  exits: ExitStatus[];
  observedAt: string;
};

export type ApplyEgressStateResponse = {
  ok: boolean;
  warnings?: string[];
  report: HostNetworkReport;
};

export type VerifyExitRequest = {
  egressIpv4: string;
  probeUrl: string;
  dnsServer?: string;
  dnsDomain?: string;
  timeoutMs?: number;
};

export type VerifyExitResponse = {
  ok: boolean;
  egressIpv4: string;
  observedIp?: string;
  ipMatch: boolean;
  httpLatencyMs: number;
  httpError?: string;
  dnsOk: boolean;
  dnsServer?: string;
  dnsLatencyMs: number;
  dnsError?: string;
};

export type EgressHttpCheckRequest = {
  egressIpv4: string;
  url: string;
  method?: string;
  headers?: Record<string, string>;
  followRedirects?: boolean;
  timeoutMs?: number;
};

export type EgressHttpCheckResponse = {
  status: number;
  finalUrl?: string;
  body?: string;
  headers?: Record<string, string>;
  latencyMs: number;
  error?: string;
};

export type SwitchEgressModeRequest = {
  mode: EgressMode;
};

export type SwitchEgressModeResponse = {
  ok: boolean;
  report?: HostNetworkReport;
  error?: string;
};
