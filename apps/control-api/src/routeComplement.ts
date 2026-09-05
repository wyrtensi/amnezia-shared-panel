import { isIP } from "node:net";

/**
 * The largest hole between two bypassed ranges that is absorbed into them
 * rather than described as its own set of tunnel routes.
 *
 * `AllowedIPs` for a whitelist profile is the inverse of the feed, and the
 * inverse costs roughly one route per hole. The RoscomVPN whitelist is
 * host-level — nearly six thousand of its entries are /30 to /32, leaving 3853
 * disjoint ranges — so inverting it verbatim produces 11140 routes, whose
 * Android VpnService parcel lands near 1.5 MB against a ~1 MB Binder limit and
 * never reaches the VPN service.
 *
 * Absorbing holes of 32 addresses or less collapses that to 4678 routes at
 * ~62% of the limit. Every feed prefix still bypasses the tunnel exactly as
 * written — nothing is widened or dropped; the only change is that 16401
 * addresses sitting in the cracks between neighbouring entries (0.0004% of
 * IPv4) bypass it too.
 */
export const WHITELIST_GAP_MERGE = 32;

/**
 * The most routes a profile may put in AllowedIPs.
 *
 * Measured on a device: a 6712-route config crossed Binder as a 941 096-byte
 * parcel, 94% of the ~1 MB a transaction gets. Past that the client drops the
 * message and the profile never connects, with no error anywhere. 5500 leaves
 * roughly a quarter of the budget for the rest of the config and for the
 * estimate itself being off.
 *
 * Feeds grow. Nothing here may assume today's list sizes, so the whitelist
 * escalates its gap merging until it fits, and the caller degrades a profile
 * that still cannot fit to the full tunnel rather than shipping a config that
 * silently refuses to connect.
 */
export const MAX_TUNNEL_ROUTES = 5500;

const LAST_ADDRESS = 0xff_ff_ff_ff;

type Range = { start: number; end: number };

const toNumber = (address: string): number | null => {
  if (isIP(address) !== 4) return null;
  return (
    address
      .split(".")
      .reduce((value, octet) => value * 256 + Number(octet), 0) >>> 0
  );
};

const toAddress = (value: number): string =>
  [
    (value >>> 24) & 0xff,
    (value >>> 16) & 0xff,
    (value >>> 8) & 0xff,
    value & 0xff,
  ].join(".");

/** An IPv4 CIDR as the inclusive address range it covers, exactly. */
const toRange = (cidr: string): Range | null => {
  const [address, prefixRaw, extra] = cidr.trim().split("/");
  if (!address || extra !== undefined) return null;
  const start = toNumber(address);
  if (start === null) return null;

  const prefix = prefixRaw === undefined ? 32 : Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;

  const end = start + 2 ** (32 - prefix) - 1;
  if (end > LAST_ADDRESS) return null;
  return { start, end };
};

/**
 * Sort by start and fuse every pair that overlaps, touches, or is separated by
 * a hole of at most `maxGap` addresses.
 */
const mergeRanges = (ranges: Range[], maxGap: number): Range[] => {
  const sorted = [...ranges].sort((left, right) => left.start - right.start);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end + 1 + maxGap) {
      last.end = Math.max(last.end, range.end);
      continue;
    }
    merged.push({ ...range });
  }
  return merged;
};

/** The smallest set of CIDRs that covers an inclusive range exactly. */
const rangeToCidrs = (range: Range): string[] => {
  const cidrs: string[] = [];
  let start = range.start;
  while (start <= range.end) {
    let prefix = 32;
    while (prefix > 0) {
      const size = 2 ** (33 - prefix);
      if (start % size !== 0 || start + size - 1 > range.end) break;
      prefix -= 1;
    }
    const size = 2 ** (32 - prefix);
    cidrs.push(`${toAddress(start)}/${prefix}`);
    // The final block can end on 255.255.255.255, where `start + size` wraps
    // past the range and the loop must stop rather than restart at zero.
    if (start + size > LAST_ADDRESS) break;
    start += size;
  }
  return cidrs;
};

/**
 * Everything in 0.0.0.0/0 that `cidrs` does not cover, as a minimal CIDR list.
 *
 * This is how a "these addresses bypass the tunnel" list becomes something a
 * WireGuard config can carry: AllowedIPs has no way to say "except", so the
 * peer is handed the inverse instead. IPv6 and malformed entries are skipped —
 * they say nothing about the IPv4 space being inverted, and a bad line in a
 * community feed must not blank out a whole profile.
 *
 * `maxGap` trades a little accuracy for a much shorter result; see
 * `WHITELIST_GAP_MERGE`. Pass 0 for the exact inverse.
 */
export const complementIpv4 = (
  cidrs: readonly string[],
  maxGap: number = WHITELIST_GAP_MERGE,
): string[] => {
  const ranges: Range[] = [];
  for (const cidr of cidrs) {
    const range = toRange(cidr);
    if (range) ranges.push(range);
  }

  const complement: string[] = [];
  let cursor = 0;
  for (const range of mergeRanges(ranges, maxGap)) {
    if (range.start > cursor) {
      complement.push(...rangeToCidrs({ start: cursor, end: range.start - 1 }));
    }
    cursor = range.end + 1;
    if (cursor > LAST_ADDRESS) return complement;
  }
  complement.push(...rangeToCidrs({ start: cursor, end: LAST_ADDRESS }));
  return complement;
};

/**
 * The complement, merged just aggressively enough to fit `maxRoutes`.
 *
 * The gap starts at `WHITELIST_GAP_MERGE` — accurate enough that the current
 * RoscomVPN list needs no escalation at all — and widens only when a feed has
 * grown or fragmented past the budget. Each step trades a little more address
 * space out of the tunnel for a shorter route list, which is the only trade
 * available: the alternative is a config the Android client discards whole.
 *
 * Returns null when even a /16-wide merge does not fit. A feed that
 * fragmented cannot be expressed as a whitelist at all, and the caller must
 * fall back to the full tunnel rather than ship something that never connects.
 */
export const complementForTunnel = (
  cidrs: readonly string[],
  maxRoutes: number = MAX_TUNNEL_ROUTES,
): { routes: string[]; gap: number } | null => {
  let gap = WHITELIST_GAP_MERGE;
  for (;;) {
    const routes = complementIpv4(cidrs, gap);
    if (routes.length <= maxRoutes) return { routes, gap };
    if (gap >= 0x1_00_00) return null;
    gap *= 8;
  }
};
