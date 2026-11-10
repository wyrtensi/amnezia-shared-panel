/**
 * Synthetic vpn:// artifacts shaped like the ones the node agent issues
 * (services/node-agent amneziaWg3.service.ts). Test-only: excluded from the
 * build. No real keys, hosts or addresses.
 */
import { encodeVpnPayload, type AmneziaPayload } from "./vpnConfig.js";

export const I_SIGNATURES = {
  I1: "<b 0xc70000000108aaaaaaaaaaaaaaaa><r 16>",
  I2: "<b 0xc70000000108bbbbbbbbbbbbbbbb><r 24>",
  I3: "<b 0xc70000000108cccccccccccccccc><r 32>",
  I4: "<b 0xdd><r 8>",
  I5: "<b 0xee><r 8>",
} as const;

type Slot = keyof typeof I_SIGNATURES;

export type Awg31FixtureOptions = {
  /** `null` leaves the marker out. */
  protocolVersion?: string | null;
  j?: { Jc: string; Jmin: string; Jmax: string } | null;
  /** Populated I slots; the rest stay as empty JSON keys with no conf line. */
  slots?: Slot[];
  crlf?: boolean;
  /** Edit the embedded conf text after it is built. */
  conf?: (text: string) => string;
  /** Edit the outer params / last_config after they are built. */
  outer?: (awg: Record<string, unknown>) => void;
  inner?: (lastConfig: Record<string, unknown>) => void;
  payload?: (payload: AmneziaPayload) => void;
};

/** Defaults as a real 3.1 node issues them: Jc 8, Jmin 62, Jmax 260, I1 and I2 populated. */
export const awg31Link = (options: Awg31FixtureOptions = {}): string => {
  const j = options.j === undefined ? { Jc: "8", Jmin: "62", Jmax: "260" } : options.j;
  const slots = options.slots ?? ["I1", "I2"];
  const params: Record<string, string> = {
    ...(j ?? {}),
    S1: "15",
    S2: "18",
    S3: "20",
    S4: "23",
    H1: "1000-2000",
    H2: "3000-4000",
    H3: "5000-6000",
    H4: "7000-8000",
  };
  for (const slot of Object.keys(I_SIGNATURES) as Slot[]) {
    params[slot] = slots.includes(slot) ? I_SIGNATURES[slot] : "";
  }
  params.HeaderProtectionKey = "synthetic-header-protection";
  params.RandomTrailers = "on";

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
    "Endpoint = vpn.example.test:443",
    "PersistentKeepalive = 25-35",
    "",
  ];
  let conf = lines.join(options.crlf ? "\r\n" : "\n");
  if (options.conf) conf = options.conf(conf);

  const lastConfig: Record<string, unknown> = {
    ...params,
    allowed_ips: ["0.0.0.0/0", "::/0"],
    client_ip: "10.8.1.7",
    client_priv_key: "synthetic-client-private-key",
    config: conf,
    hostName: "vpn.example.test",
    mtu: "1376",
    persistent_keep_alive: "25-35",
    port: 443,
    psk_key: "synthetic-psk",
    server_pub_key: "synthetic-server-public-key",
  };
  options.inner?.(lastConfig);
  const awg: Record<string, unknown> = {
    ...params,
    ...(options.protocolVersion === null
      ? {}
      : { protocol_version: options.protocolVersion ?? "3.1" }),
    last_config: JSON.stringify(lastConfig, null, 2),
    port: "443",
    transport_proto: "udp",
  };
  options.outer?.(awg);
  const payload: AmneziaPayload = {
    containers: [{ awg, container: "amnezia-awg2" }],
    defaultContainer: "amnezia-awg2",
    description: "synthetic",
    dns1: "1.1.1.1",
    dns2: "1.0.0.1",
    hostName: "vpn.example.test",
  };
  options.payload?.(payload);
  return encodeVpnPayload(payload);
};

/** The three copies of one field: outer params, last_config, conf line. */
export const readCopies = (vpnLink: string, decode: (link: string) => AmneziaPayload) => {
  const awg = decode(vpnLink).containers?.[0]?.awg ?? {};
  const lastConfig = JSON.parse(String(awg.last_config)) as Record<string, unknown>;
  const conf = String(lastConfig.config);
  const line = (key: string) =>
    new RegExp(`^${key} = (.*?)\\r?$`, "m").exec(conf)?.[1] ?? null;
  return { awg, lastConfig, conf, line };
};
