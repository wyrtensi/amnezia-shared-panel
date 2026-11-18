/**
 * Synthetic vpn:// service-key artifacts shaped like the ones the node agent
 * issues. Test-only: excluded from the build. No real keys, hosts or
 * addresses.
 */
import { encodeVpnPayload } from "@amnezia/vpn-config";

export const awgServiceLink = (
  options: { protocolVersion?: string | null; host?: string; port?: number } = {},
): string => {
  const host = options.host ?? "node.example.test";
  const port = options.port ?? 51820;
  const conf = [
    "[Interface]",
    "Address = 10.8.1.7/32",
    "PrivateKey = synthetic-client-private-key",
    "Jc = 8",
    "",
    "[Peer]",
    "PublicKey = synthetic-server-public-key",
    "AllowedIPs = 0.0.0.0/0, ::/0",
    `Endpoint = ${host}:${port}`,
    "",
  ].join("\n");
  const lastConfig = { config: conf, hostName: host, port, client_ip: "10.8.1.7" };
  return encodeVpnPayload({
    containers: [
      {
        container: "amnezia-awg2",
        awg: {
          ...(options.protocolVersion === null
            ? {}
            : { protocol_version: options.protocolVersion ?? "3.1" }),
          last_config: JSON.stringify(lastConfig, null, 2),
          port: String(port),
          transport_proto: "udp",
        },
      },
    ],
    defaultContainer: "amnezia-awg2",
    description: "synthetic",
    hostName: host,
  });
};
