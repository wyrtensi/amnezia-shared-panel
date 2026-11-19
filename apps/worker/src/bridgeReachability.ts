import { createHash } from "node:crypto";
import type { ProbeBridgeTargetResult, ReachabilityStatus } from "@amnezia/contracts";

import { nodeStatus, type ProtocolOutcome } from "./reachability.js";

export const bridgeHostTargetId = (bridgeId: string, publicIpv4: string, hostname: string | null): string => {
  const endpoint = createHash("sha256").update(`${publicIpv4}\n${hostname ?? ""}`).digest("hex");
  return `${bridgeId}:host:${endpoint}`;
};

export const bridgeExternalVerdict = (
  awg: readonly ProtocolOutcome[],
  host: ProbeBridgeTargetResult | undefined,
  panelDnsHostname: string | null,
): { status: ReachabilityStatus; detail: string | null } => {
  // Actual AWG evidence takes priority. An answering SSH or HTTPS port
  // cannot hide a failed tunnel. One usable AWG route proves reachability.
  if (awg.some((outcome) => outcome.levels !== null)) {
    const status = nodeStatus(awg);
    return {
      status,
      detail: status === "ok" ? null : "AWG 3.1: " +
        (awg.find((outcome) => outcome.status === status)?.detail ?? "incomplete measurements"),
    };
  }
  if (!host || host.status === "error") {
    return { status: "error", detail: host?.detail ?? awg[0]?.detail ?? "no external measurement" };
  }
  const { ping, tcp, https } = host.levels;
  const pass = panelDnsHostname
    ? https?.ok
    : ping.ok === true || tcp.ok === true
      ? true
      : ping.ok === false && tcp.ok === false ? false : null;
  return pass === true
    ? { status: "ok", detail: null }
    : {
        status: pass === false ? "failed" : "error",
        detail: panelDnsHostname ? "panel HTTPS check did not pass" : "bridge host check did not pass",
      };
};
