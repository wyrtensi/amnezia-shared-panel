import { inspectAwgVpnLink, type AwgEndpoint } from "@amnezia/vpn-config";
import { ApiError } from "./service.js";

export const selectDirectAddress = (link: string, address?: string): AwgEndpoint | null => {
  if (!address) return null;
  const inspection = inspectAwgVpnLink(link);
  if (inspection.kind !== "awg31") {
    throw new ApiError(409, "Address selection requires an AWG 3.1 config", "NODE_ENDPOINT_CONFIG_UNSUPPORTED");
  }
  return { host: address, port: inspection.endpoint.port };
};
