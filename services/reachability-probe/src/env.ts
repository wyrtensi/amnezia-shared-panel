import { readFileSync } from "node:fs";

export const MIN_API_KEY_LENGTH = 32;
export const DEFAULT_LISTEN = "0.0.0.0:4002";
export const DEFAULT_API_KEY_FILE = "/run/secrets/probe_api_key";

/** `host:port` from PROBE_LISTEN. */
export const parseListen = (value: string | undefined): { host: string; port: number } => {
  const text = value?.trim() || DEFAULT_LISTEN;
  const colon = text.lastIndexOf(":");
  const host = colon > 0 ? text.slice(0, colon).replace(/^\[|\]$/g, "") : "";
  const portText = colon > 0 ? text.slice(colon + 1) : "";
  const port = /^\d+$/.test(portText) ? Number(portText) : NaN;
  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("PROBE_LISTEN must be host:port");
  }
  return { host, port };
};

/** Read the API key file. The key itself never appears in an error. */
export const loadApiKey = (path: string): string => {
  let key: string;
  try {
    key = readFileSync(path, "utf8").trim();
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    throw new Error(`cannot read the API key file (${typeof code === "string" ? code : "error"})`);
  }
  if (key.length < MIN_API_KEY_LENGTH) {
    throw new Error(`the API key must contain at least ${MIN_API_KEY_LENGTH} characters`);
  }
  return key;
};
