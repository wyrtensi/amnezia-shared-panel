/**
 * Synthetic artifacts shaped like the ones the node agent serializes
 * (services/node-agent amneziaWgServiceBase.ts). Test-only: excluded from the
 * build. No real keys, hosts or addresses.
 */
import { encodeVpnPayload, type AmneziaPayload } from "./codec.js";

export type ArtifactOptions = {
  /** `null` leaves the marker out, as the legacy AWG layout does. */
  protocolVersion?: string | null;
  container?: string;
  host?: string;
  port?: number;
  /** Override the embedded config text. */
  conf?: (text: string) => string;
};

export const buildArtifact = (options: ArtifactOptions = {}): AmneziaPayload => {
  const host = options.host ?? "node.example.test";
  const port = options.port ?? 51820;
  const container = options.container ?? "amnezia-awg2";
  const v31 = (options.protocolVersion ?? "3.1") === "3.1";
  const params: Record<string, string> = {
    Jc: "8",
    Jmin: "62",
    Jmax: "260",
    S1: "15",
    S2: "18",
    H1: "1000-2000",
    H2: "3000-4000",
    H3: "5000-6000",
    H4: "7000-8000",
    ...(v31
      ? {
          S3: "20",
          S4: "23",
          I1: "<b 0xc70000000108aaaaaaaaaaaaaaaa><r 16>",
          I2: "",
          I3: "",
          I4: "",
          I5: "",
          HeaderProtectionKey: "synthetic-header-protection",
        }
      : {}),
  };
  const lines = [
    "[Interface]",
    "Address = 10.8.1.7/32",
    "DNS = 1.1.1.1, 1.0.0.1",
    "PrivateKey = synthetic-client-private-key",
    ...Object.entries(params)
      .filter(([, value]) => value !== "")
      .map(([key, value]) => `${key} = ${value}`),
    "",
    "[Peer]",
    "PublicKey = synthetic-server-public-key",
    "PresharedKey = synthetic-psk",
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${host}:${port}`,
    `PersistentKeepalive = ${v31 ? "25-35" : "25"}`,
    "",
  ];
  const conf = options.conf ? options.conf(lines.join("\n")) : lines.join("\n");
  const lastConfig = {
    ...params,
    allowed_ips: ["0.0.0.0/0", "::/0"],
    clientId: "synthetic-client-pub-key",
    client_ip: "10.8.1.7",
    client_priv_key: "synthetic-client-private-key",
    client_pub_key: "synthetic-client-pub-key",
    config: conf,
    hostName: host,
    mtu: "1376",
    persistent_keep_alive: v31 ? "25-35" : "25",
    port,
    psk_key: "synthetic-psk",
    server_pub_key: "synthetic-server-public-key",
  };
  const awg: Record<string, unknown> = {
    ...params,
    ...(options.protocolVersion === null
      ? {}
      : { protocol_version: options.protocolVersion ?? "3.1" }),
    last_config: JSON.stringify(lastConfig, null, 2),
    port: String(port),
    transport_proto: "udp",
  };
  return {
    containers: [{ awg, container }],
    defaultContainer: container,
    description: "synthetic",
    dns1: "1.1.1.1",
    dns2: "1.0.0.1",
    hostName: host,
  };
};

export const buildLink = (options?: ArtifactOptions): string =>
  encodeVpnPayload(buildArtifact(options));

/** The three places one endpoint lives in. */
export const readEndpointCopies = (payload: AmneziaPayload) => {
  const awg = payload.containers?.[0]?.awg ?? {};
  const lastConfig = JSON.parse(String(awg.last_config)) as Record<string, unknown>;
  return {
    top: payload.hostName,
    awgPort: awg.port,
    lastHost: lastConfig.hostName,
    lastPort: lastConfig.port,
    endpointLines: String(lastConfig.config).match(/^Endpoint = .*$/gm) ?? [],
  };
};
