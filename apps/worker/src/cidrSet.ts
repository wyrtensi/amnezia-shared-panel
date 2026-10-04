import { isIP } from "node:net";

/**
 * Address-range arithmetic for rule feeds: enough to take one set of prefixes
 * away from another without a dependency.
 *
 * Everything is a closed `[start, end]` range of bigints per address family, so
 * IPv4 and IPv6 go through the same code and a /0 is as cheap as a /32.
 */

type Family = 4 | 6;
type Range = { family: Family; start: bigint; end: bigint };

const FAMILY_BITS: Record<Family, number> = { 4: 32, 6: 128 };

const parseIpv4 = (address: string): bigint =>
  address
    .split(".")
    .reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);

const parseIpv6 = (address: string): bigint => {
  let text = address;
  // An embedded dotted quad (`::ffff:192.0.2.1`) is the last two groups.
  const dotted = text.lastIndexOf(":");
  const tail = text.slice(dotted + 1);
  if (tail.includes(".")) {
    const v4 = parseIpv4(tail);
    text = `${text.slice(0, dotted + 1)}${(v4 >> 16n).toString(16)}:${(v4 & 0xffffn).toString(16)}`;
  }
  const [head = "", rest] = text.split("::");
  const headGroups = head ? head.split(":") : [];
  const restGroups = rest ? rest.split(":") : [];
  const groups =
    rest === undefined
      ? headGroups
      : [
          ...headGroups,
          ...Array<string>(8 - headGroups.length - restGroups.length).fill("0"),
          ...restGroups,
        ];
  return groups.reduce(
    (value, group) => (value << 16n) | BigInt(Number.parseInt(group, 16)),
    0n,
  );
};

/** Parse a prefix that already passed `isCidr`; anything else is null. */
const parseCidr = (cidr: string): Range | null => {
  const [address = "", prefixRaw = ""] = cidr.split("/");
  const version = isIP(address);
  if (version !== 4 && version !== 6) return null;
  const family: Family = version;
  const bits = FAMILY_BITS[family];
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const value = family === 4 ? parseIpv4(address) : parseIpv6(address);
  const hostBits = BigInt(bits - prefix);
  // Feeds write host bits now and then (`1.2.3.4/24`); the network is what
  // AllowedIPs routes, so normalise to it.
  const start = (value >> hostBits) << hostBits;
  return { family, start, end: start + (1n << hostBits) - 1n };
};

const formatAddress = (family: Family, value: bigint): string => {
  if (family === 4) {
    return [24n, 16n, 8n, 0n].map((shift) => String((value >> shift) & 0xffn)).join(".");
  }
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
  // Compress the longest run of zero groups (two or more) to `::`.
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < 8; ) {
    if (groups[index] !== "0") {
      index += 1;
      continue;
    }
    let end = index;
    while (end < 8 && groups[end] === "0") end += 1;
    if (end - index > bestLength) {
      bestStart = index;
      bestLength = end - index;
    }
    index = end;
  }
  if (bestStart < 0) return groups.join(":");
  const head = groups.slice(0, bestStart).join(":");
  const tail = groups.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
};

/** The fewest prefixes that cover exactly `[start, end]`. */
const rangeToCidrs = (family: Family, start: bigint, end: bigint): string[] => {
  const bits = FAMILY_BITS[family];
  const cidrs: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    // Widest block aligned at `cursor` that does not run past `end`.
    let hostBits = 0;
    while (
      hostBits < bits &&
      (cursor & ((1n << BigInt(hostBits + 1)) - 1n)) === 0n &&
      cursor + (1n << BigInt(hostBits + 1)) - 1n <= end
    ) {
      hostBits += 1;
    }
    cidrs.push(`${formatAddress(family, cursor)}/${bits - hostBits}`);
    cursor += 1n << BigInt(hostBits);
  }
  return cidrs;
};

/** Sorted, merged, non-overlapping ranges for one family. */
const mergeRanges = (ranges: Range[]): Range[] => {
  const sorted = [...ranges].sort((a, b) =>
    a.start < b.start ? -1 : a.start > b.start ? 1 : 0,
  );
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged.at(-1);
    if (last && range.start <= last.end + 1n) {
      if (range.end > last.end) last.end = range.end;
    } else {
      merged.push({ ...range });
    }
  }
  return merged;
};

const sizeOf = (ranges: Range[]): bigint =>
  mergeRanges(ranges).reduce((total, range) => total + range.end - range.start + 1n, 0n);

export type CidrSubtraction = {
  /**
   * The fewest prefixes covering exactly the included addresses minus the
   * excluded ones, IPv4 first, each family in address order.
   */
  cidrs: string[];
  /** How many include prefixes lost some or all of their addresses. */
  touched: number;
  /**
   * Share of the included address space the exclusion removed, per family —
   * 0 when that family had nothing included. What a too-broad exclusion list
   * shows up as.
   */
  removedShare: Record<Family, number>;
};

/**
 * Remove every address in `exclude` from `include`, and return what is left as
 * the smallest prefix list that covers it.
 *
 * The result is compacted even where nothing was excluded: feeds overlap and
 * sit side by side (iplist's /24 inside an itdoginfo /16, two adjacent /24s
 * from two sources), and every prefix is a route the Android client has to
 * carry under its Binder ceiling. Merging covers exactly the same addresses
 * in fewer routes. Inputs must already be valid prefixes (`isCidr`); an
 * unparseable one is passed through unchanged rather than dropped.
 */
export const subtractCidrs = (include: string[], exclude: string[]): CidrSubtraction => {
  const excluded: Record<Family, Range[]> = { 4: [], 6: [] };
  for (const cidr of exclude) {
    const range = parseCidr(cidr);
    if (range) excluded[range.family].push(range);
  }
  const blocks: Record<Family, Range[]> = {
    4: mergeRanges(excluded[4]),
    6: mergeRanges(excluded[6]),
  };

  const included: Record<Family, Range[]> = { 4: [], 6: [] };
  const kept: Record<Family, Range[]> = { 4: [], 6: [] };
  const cidrs: string[] = [];
  let touched = 0;

  for (const cidr of include) {
    const range = parseCidr(cidr);
    if (!range) {
      cidrs.push(cidr);
      continue;
    }
    included[range.family].push(range);
    const familyBlocks = blocks[range.family];
    // First block that ends at or after this prefix starts.
    let low = 0;
    let high = familyBlocks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (familyBlocks[middle]!.end < range.start) low = middle + 1;
      else high = middle;
    }
    if (low >= familyBlocks.length || familyBlocks[low]!.start > range.end) {
      kept[range.family].push(range);
      continue;
    }
    touched += 1;
    let cursor = range.start;
    for (
      let index = low;
      index < familyBlocks.length && familyBlocks[index]!.start <= range.end;
      index += 1
    ) {
      const block = familyBlocks[index]!;
      if (block.start > cursor) {
        kept[range.family].push({
          family: range.family,
          start: cursor,
          end: block.start - 1n,
        });
      }
      if (block.end >= range.end) {
        cursor = range.end + 1n;
        break;
      }
      cursor = block.end + 1n;
    }
    if (cursor <= range.end) {
      kept[range.family].push({ family: range.family, start: cursor, end: range.end });
    }
  }

  const share = (family: Family): number => {
    const total = sizeOf(included[family]);
    if (total === 0n) return 0;
    const removed = total - sizeOf(kept[family]);
    // Scale before dividing so a bigint ratio keeps four decimal places.
    return Number((removed * 10_000n) / total) / 10_000;
  };

  for (const family of [4, 6] as const) {
    for (const range of mergeRanges(kept[family])) {
      cidrs.push(...rangeToCidrs(family, range.start, range.end));
    }
  }

  return {
    cidrs: [...new Set(cidrs)],
    touched,
    removedShare: { 4: share(4), 6: share(6) },
  };
};
