// Wire types of the probe API. The panel mirrors them in @amnezia/contracts;
// change both together, and add new fields as optional.

/** One level of a check. `ok: null` means not attempted. */
export type LevelResult = { ok: boolean | null; detail: string | null; latencyMs: number | null };

export type TargetLevels = {
  ping: LevelResult;
  tcp: LevelResult;
  handshake: LevelResult;
  http: LevelResult;
};

export type TargetResult = {
  targetId: string;
  protocol: string;
  /** `error`: the target could not be attempted, so nothing is known about the node. */
  status: "done" | "error";
  detail: string | null;
  endpointHost: string | null;
  egressIp: string | null;
  levels: TargetLevels;
};

export type RunTarget = {
  targetId: string;
  protocol: string;
  /** A `vpn://` link or raw conf text. Grants VPN access: never echoed or logged. */
  config: string;
  expectedEgressIp?: string;
};

export type RunRequest = {
  runId: string;
  control: { url: string };
  egress: { url: string };
  targets: RunTarget[];
};

export type RunState = {
  runId: string;
  startedAt: string;
  finishedAt: string | null;
  control: LevelResult;
  results: TargetResult[];
};

export const notAttempted = (): LevelResult => ({ ok: null, detail: null, latencyMs: null });
