import ipaddr from "ipaddr.js";

const toInteger = (address: ipaddr.IPv4): number =>
  address.octets.reduce((value, octet) => value * 256 + octet, 0) >>> 0;

const fromInteger = (value: number): string =>
  [24, 16, 8, 0].map((shift) => (value >>> shift) & 0xff).join(".");

const parseIpv4Cidr = (cidr: string): [ipaddr.IPv4, number] => {
  try {
    const [address, prefix] = ipaddr.parseCIDR(cidr);
    if (address.kind() !== "ipv4") throw new Error("not IPv4");
    return [address as ipaddr.IPv4, prefix];
  } catch {
    throw new Error(`Expected an IPv4 server CIDR, received: ${cidr}`);
  }
};

export const allocatePeerIp = (
  serverCidr: string,
  usedPeerCidrs: readonly string[],
): string | null => {
  const [serverAddress, prefix] = parseIpv4Cidr(serverCidr);
  const network = toInteger(ipaddr.IPv4.networkAddressFromCIDR(serverCidr));
  const broadcast = toInteger(ipaddr.IPv4.broadcastAddressFromCIDR(serverCidr));
  const server = toInteger(serverAddress);
  const used = new Set<number>();

  for (const peerCidr of usedPeerCidrs) {
    try {
      const [address, peerPrefix] = ipaddr.parseCIDR(peerCidr);
      if (address.kind() !== "ipv4" || peerPrefix !== 32) continue;
      const value = toInteger(address as ipaddr.IPv4);
      if (value > network && value < broadcast) used.add(value);
    } catch {
      continue;
    }
  }

  if (prefix >= 31) return null;

  for (let candidate = network + 1; candidate < broadcast; candidate += 1) {
    if (candidate !== server && !used.has(candidate)) {
      return fromInteger(candidate);
    }
  }

  return null;
};
