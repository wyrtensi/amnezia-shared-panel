import { deflateSync, inflateSync } from "node:zlib";

export type AmneziaContainerAwg = {
  last_config?: string | Record<string, unknown>;
  [key: string]: unknown;
};

export type AmneziaContainer = {
  container?: string;
  awg?: AmneziaContainerAwg;
  [key: string]: unknown;
};

export type AmneziaPayload = {
  containers?: AmneziaContainer[];
  defaultContainer?: string;
  description?: string;
  dns1?: string;
  dns2?: string;
  hostName?: string;
  [key: string]: unknown;
};

export type AwgLastConfig = {
  form: "json-indent2" | "json-compact" | "object";
  lastConfig: Record<string, unknown>;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Decode an embedded config while retaining its wire representation. */
export const readAwgLastConfig = (stored: unknown): AwgLastConfig | null => {
  if (isRecord(stored)) return { form: "object", lastConfig: stored };
  if (typeof stored !== "string") return null;

  let lastConfig: unknown;
  try {
    lastConfig = JSON.parse(stored);
  } catch {
    return null;
  }
  if (!isRecord(lastConfig)) return null;
  const form = JSON.stringify(lastConfig, null, 2) === stored || JSON.stringify(lastConfig) !== stored
    ? "json-indent2"
    : "json-compact";
  return { form, lastConfig };
};

export const writeAwgLastConfig = (
  awg: AmneziaContainerAwg,
  form: AwgLastConfig["form"],
  lastConfig: Record<string, unknown>,
): void => {
  awg.last_config = form === "object"
    ? lastConfig
    : JSON.stringify(lastConfig, null, form === "json-indent2" ? 2 : 0);
};

export const encodeVpnPayload = (payload: AmneziaPayload): string => {
  const raw = Buffer.from(JSON.stringify(payload));
  const header = Buffer.alloc(4);
  header.writeUInt32BE(raw.length, 0);
  return `vpn://${Buffer.concat([header, deflateSync(raw)]).toString("base64url")}`;
};

export const decodeVpnLink = (vpnLink: string): AmneziaPayload => {
  if (!vpnLink.startsWith("vpn://")) {
    throw new Error("VPN config must start with vpn://");
  }
  const payload = Buffer.from(vpnLink.slice("vpn://".length), "base64url");
  if (payload.byteLength < 5) {
    throw new Error("VPN config payload is too short");
  }
  const expectedLength = payload.readUInt32BE(0);
  const raw = inflateSync(payload.subarray(4));
  if (raw.byteLength !== expectedLength) {
    throw new Error("VPN config payload length does not match its header");
  }
  return JSON.parse(raw.toString("utf8")) as AmneziaPayload;
};
