import {
  AwgEndpointRenderError,
  inspectAwgVpnLink,
  renderAwgEndpointVpnLink,
  type AwgEndpoint,
} from "@amnezia/vpn-config";
import { ApiError } from "./service.js";

/** Documentation address (RFC 5737) used for trial renders only. */
const TRIAL_ENDPOINT: AwgEndpoint = { host: "192.0.2.1", port: 41000 };

/**
 * How a stored key config relates to a bridge endpoint:
 * - `native-direct`: issued as AWG 2; never inspected, always Direct.
 * - `awg31`: issued as AWG 3 with a confirmed 3.1 artifact; renders to a bridge.
 * - `awg20`: issued as AWG 3 but the artifact is the 2.0 fallback; Direct.
 * - `unsupported`: AWG 3 artifact that is unrecognized, ambiguous or unreadable.
 */
export type BridgeKeyClass =
  | "native-direct"
  | "awg31"
  | "awg20"
  | "unsupported";

/** `link` is the decrypted vpn:// artifact, or null when it could not be read. */
export const classifyKeyForBridge = (
  protocol: "awg2" | "awg3",
  link: string | null,
): BridgeKeyClass => {
  if (protocol === "awg2") return "native-direct";
  if (link === null) return "unsupported";
  const inspected = inspectAwgVpnLink(link);
  if (inspected.kind === "awg31") return "awg31";
  if (inspected.kind === "awg20") return "awg20";
  return "unsupported";
};

/** Whether the renderer can actually write an endpoint into this 3.1 link. */
export const canRenderBridgeEndpoint = (link: string): boolean => {
  try {
    renderAwgEndpointVpnLink(link, TRIAL_ENDPOINT);
    return true;
  } catch {
    return false;
  }
};

export const bridgeConfigUnsupported = (): ApiError =>
  new ApiError(
    409,
    "This key's stored config cannot be served through the node's bridge",
    "BRIDGE_CONFIG_UNSUPPORTED",
  );

/**
 * Which link to deliver: the saved artifact for Direct, the artifact with the
 * bridge endpoint written in otherwise. Call with the key's decrypted base
 * artifact. `bridge` null means Direct. Errors are sanitized 409s that carry
 * no artifact content.
 */
export const decideBridgeDelivery = (
  protocol: "awg2" | "awg3",
  baseLink: string,
  bridge: AwgEndpoint | null,
): { mode: "direct" } | { mode: "bridge"; endpoint: AwgEndpoint } => {
  if (bridge === null) return { mode: "direct" };
  const cls = classifyKeyForBridge(protocol, baseLink);
  if (cls === "native-direct" || cls === "awg20") return { mode: "direct" };
  if (cls === "unsupported") throw bridgeConfigUnsupported();
  return { mode: "bridge", endpoint: bridge };
};

export const renderBridgeEndpoint = (
  link: string,
  endpoint: AwgEndpoint,
): string => {
  try {
    return renderAwgEndpointVpnLink(link, endpoint);
  } catch (error) {
    if (error instanceof AwgEndpointRenderError) throw bridgeConfigUnsupported();
    throw error;
  }
};
