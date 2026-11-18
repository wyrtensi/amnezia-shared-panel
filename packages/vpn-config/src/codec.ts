import { deflateSync, inflateSync } from "node:zlib";

export type AmneziaContainerAwg = {
  last_config?: string;
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
