import { isIP } from "node:net";

/**
 * Pure BigInt address-range and binary-trie CIDR arithmetic shared between the
 * worker (feed compaction) and control-api (export-time admin exclusions).
 *
 * Everything is modeled as closed `[start, end]` BigInt intervals per address
 * family, so IPv4 and IPv6 use the exact same code and a `/0` is as cheap as a
 * `/32` or `/128`.
 */

export type CidrFamily = 4 | 6;

type Range = { family: CidrFamily; start: bigint; end: bigint };
type AlignedPrefix = { start: bigint; end: bigint; prefix: number };

const FAMILY_BITS: Record<CidrFamily, number> = { 4: 32, 6: 128 };

/**
 * Private, local, CGNAT, documentation, multicast, and reserved IPv4 blocks
 * that gap-filling supernetting must never pull into a VPN tunnel.
 */
export const BOGON_V4_CIDRS: readonly string[] = [
  "0.0.0.0/8",
  "10.0.0.0/8",
  "100.64.0.0/10",
  "127.0.0.0/8",
  "169.254.0.0/16",
  "172.16.0.0/12",
  "192.0.0.0/24",
  "192.0.2.0/24",
  "192.88.99.0/24",
  "192.168.0.0/16",
  "198.18.0.0/15",
  "198.51.100.0/24",
  "203.0.113.0/24",
  "224.0.0.0/4",
  "240.0.0.0/4",
];

/**
 * Everything outside IPv6 Global Unicast (`2000::/3`) plus RFC 3849
 * documentation space (`2001:db8::/32`). Keeping this forbidden ensures
 * IPv6 supernets stay strictly inside routable global unicast space.
 */
export const BOGON_V6_CIDRS: readonly string[] = [
  "::/3",
  "4000::/2",
  "8000::/1",
  "2001:db8::/32",
];

/**
 * Apple's global IPv4 allocation (iCloud backups, iOS/macOS updates, App Store
 * payloads). Keeping it direct avoids burning VPS bandwidth on OS updates.
 */
export const APPLE_DIRECT_V4_CIDRS: readonly string[] = ["17.0.0.0/8"];

/**
 * Valve AS32590 IPv4 prefixes hosting primary SteamCache download servers
 * (`cache*.steamcontent.com`). Steam Store, Community, Login, and Checkout
 * (`store.steampowered.com`, `steamcommunity.com`, `api.steampowered.com`)
 * are served via Akamai + Fastly rather than AS32590, so excluding these
 * prefixes sends heavy primary SteamCache game downloads direct while keeping
 * store/community/checkout routed through the VPN in `compact_world` (E-Core).
 */
export const STEAM_CACHE_V4_CIDRS: readonly string[] = [
  "45.121.184.0/22",
  "103.10.124.0/23",
  "103.28.54.0/23",
  "146.66.152.0/21",
  "155.133.224.0/19",
  "162.254.192.0/21",
  "185.25.180.0/22",
  "192.69.96.0/22",
  "205.196.6.0/24",
  "208.64.200.0/22",
  "208.78.164.0/22",
];

/** Valve AS32590 IPv6 allocations (covering all 33 RIPEstat announced /48s). */
export const STEAM_CACHE_V6_CIDRS: readonly string[] = [
  "2404:3fc0::/32",
  "2602:801:f000::/44",
  "2a01:bc80::/32",
];

/**
 * AliExpress Russia / Alibaba Cloud CDN IPv4 prefix (`aliexpress.ru`,
 * `m.aliexpress.ru`, `login.aliexpress.ru`, `trade.aliexpress.ru` resolve into
 * `47.246.133.0/24`). Not listed in Russian GeoIP (`ipdeny`), so in
 * `compact_world` it would otherwise be absorbed into `47.0.0.0/8` and routed
 * through the VPN, where Alibaba CDN frequently blocks datacenter egress IPs.
 */
export const ALIEXPRESS_DIRECT_V4_CIDRS: readonly string[] = ["47.246.0.0/16"];

const parseIpv4 = (address: string): bigint =>
  address
    .split(".")
    .reduce((value, octet) => (value << 8n) | BigInt(Number(octet)), 0n);

const parseIpv6 = (address: string): bigint => {
  let text = address;
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

/**
 * Normalize a bare IP literal to a host CIDR (`/32` or `/128`) while leaving
 * existing CIDR strings and non-IP strings unchanged.
 */
export const normalizeCidrOrIp = (raw: string): string => {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("/")) return trimmed;
  const version = isIP(trimmed);
  if (version === 4) return `${trimmed}/32`;
  if (version === 6) return `${trimmed}/128`;
  return trimmed;
};

/** Parse a CIDR string into a normalized closed BigInt range, or null. */
const parseCidr = (cidr: string): Range | null => {
  const [address = "", prefixRaw = "", extra] = cidr.split("/");
  if (!address || !prefixRaw || extra !== undefined) return null;
  if (!/^\d{1,3}$/.test(prefixRaw)) return null;
  const version = isIP(address);
  if (version !== 4 && version !== 6) return null;
  const family: CidrFamily = version;
  const bits = FAMILY_BITS[family];
  const prefix = Number(prefixRaw);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > bits) return null;
  const value = family === 4 ? parseIpv4(address) : parseIpv6(address);
  const hostBits = BigInt(bits - prefix);
  const start = (value >> hostBits) << hostBits;
  return { family, start, end: start + (1n << hostBits) - 1n };
};

const formatAddress = (family: CidrFamily, value: bigint): string => {
  if (family === 4) {
    return [24n, 16n, 8n, 0n]
      .map((shift) => String((value >> shift) & 0xffn))
      .join(".");
  }
  const groups = Array.from({ length: 8 }, (_, index) =>
    ((value >> BigInt((7 - index) * 16)) & 0xffffn).toString(16),
  );
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

/** Decompose `[start, end]` into the minimal set of aligned CIDR blocks. */
const rangeToAlignedPrefixes = (
  family: CidrFamily,
  start: bigint,
  end: bigint,
): AlignedPrefix[] => {
  const bits = FAMILY_BITS[family];
  const out: AlignedPrefix[] = [];
  let cursor = start;
  while (cursor <= end) {
    let hostBits = 0;
    while (
      hostBits < bits &&
      (cursor & ((1n << BigInt(hostBits + 1)) - 1n)) === 0n &&
      cursor + (1n << BigInt(hostBits + 1)) - 1n <= end
    ) {
      hostBits += 1;
    }
    const blockSize = 1n << BigInt(hostBits);
    out.push({ start: cursor, end: cursor + blockSize - 1n, prefix: bits - hostBits });
    cursor += blockSize;
  }
  return out;
};

const rangeToCidrs = (family: CidrFamily, start: bigint, end: bigint): string[] =>
  rangeToAlignedPrefixes(family, start, end).map(
    (block) => `${formatAddress(family, block.start)}/${block.prefix}`,
  );

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

const hasRangeOverlap = (
  start: bigint,
  end: bigint,
  sortedDisjoint: Range[],
): boolean => {
  let lo = 0;
  let hi = sortedDisjoint.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const interval = sortedDisjoint[mid]!;
    if (interval.end < start) lo = mid + 1;
    else if (interval.start > end) hi = mid - 1;
    else return true;
  }
  return false;
};

const rangesByFamily = (cidrs: readonly string[]): Record<CidrFamily, Range[]> => {
  const grouped: Record<CidrFamily, Range[]> = { 4: [], 6: [] };
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed) grouped[parsed.family].push(parsed);
  }
  return {
    4: mergeRanges(grouped[4]),
    6: mergeRanges(grouped[6]),
  };
};

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
   * 0 when that family had nothing included.
   */
  removedShare: Record<CidrFamily, number>;
};

/**
 * Remove every address in `exclude` from `include`, and return what is left as
 * the smallest prefix list that covers it.
 *
 * The result is compacted even where nothing was excluded. Inputs that cannot
 * be parsed as a CIDR are passed through unchanged rather than dropped.
 */
export const subtractCidrs = (
  include: readonly string[],
  exclude: readonly string[],
): CidrSubtraction => {
  const blocks = rangesByFamily(exclude);
  const included: Record<CidrFamily, Range[]> = { 4: [], 6: [] };
  const kept: Record<CidrFamily, Range[]> = { 4: [], 6: [] };
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
      kept[range.family].push({
        family: range.family,
        start: cursor,
        end: range.end,
      });
    }
  }

  const share = (family: CidrFamily): number => {
    const total = sizeOf(included[family]);
    if (total === 0n) return 0;
    const removed = total - sizeOf(kept[family]);
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

/**
 * Subtract `exclude` from `include` while keeping every prefix in `include`
 * that does not overlap `exclude` verbatim and in its original order. Prefixes
 * that DO overlap `exclude` are replaced in place by the minimal aligned blocks
 * covering their remaining addresses (or dropped if covered whole).
 *
 * Used at export time for admin global exclusions: punches exact CIDR holes out
 * of enclosing supernets without unexpectedly re-aggregating unrelated entries.
 */
export const subtractCidrsPreservingUntouched = (
  include: readonly string[],
  exclude: readonly string[],
): string[] => {
  if (exclude.length === 0) return [...include];
  const blocks = rangesByFamily(exclude.map(normalizeCidrOrIp));
  const out: string[] = [];

  for (const raw of include) {
    const range = parseCidr(normalizeCidrOrIp(raw));
    if (!range) {
      out.push(raw);
      continue;
    }
    const familyBlocks = blocks[range.family];
    let low = 0;
    let high = familyBlocks.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (familyBlocks[middle]!.end < range.start) low = middle + 1;
      else high = middle;
    }
    if (low >= familyBlocks.length || familyBlocks[low]!.start > range.end) {
      out.push(raw);
      continue;
    }
    let cursor = range.start;
    for (
      let index = low;
      index < familyBlocks.length && familyBlocks[index]!.start <= range.end;
      index += 1
    ) {
      const block = familyBlocks[index]!;
      if (block.start > cursor) {
        out.push(...rangeToCidrs(range.family, cursor, block.start - 1n));
      }
      if (block.end >= range.end) {
        cursor = range.end + 1n;
        break;
      }
      cursor = block.end + 1n;
    }
    if (cursor <= range.end) {
      out.push(...rangeToCidrs(range.family, cursor, range.end));
    }
  }
  return out;
};

/** Partition a CIDR list into IPv4 and IPv6 lists. */
export const splitCidrsByFamily = (
  cidrs: readonly string[],
): Record<CidrFamily, string[]> => {
  const out: Record<CidrFamily, string[]> = { 4: [], 6: [] };
  for (const cidr of cidrs) {
    const parsed = parseCidr(cidr);
    if (parsed) out[parsed.family].push(cidr);
  }
  return out;
};

/** Total distinct address count per family covered by `cidrs`. */
export const measureCidrSpace = (
  cidrs: readonly string[],
): Record<CidrFamily, bigint> => {
  const grouped = rangesByFamily(cidrs);
  return {
    4: sizeOf(grouped[4]),
    6: sizeOf(grouped[6]),
  };
};

/** Exact overlap address count per family between two CIDR sets. */
export const countCidrOverlap = (
  left: readonly string[],
  right: readonly string[],
): Record<CidrFamily, bigint> => {
  const a = rangesByFamily(left);
  const b = rangesByFamily(right);
  const overlapFor = (family: CidrFamily): bigint => {
    const ra = a[family];
    const rb = b[family];
    let i = 0;
    let j = 0;
    let total = 0n;
    while (i < ra.length && j < rb.length) {
      const lo = ra[i]!.start > rb[j]!.start ? ra[i]!.start : rb[j]!.start;
      const hi = ra[i]!.end < rb[j]!.end ? ra[i]!.end : rb[j]!.end;
      if (lo <= hi) total += hi - lo + 1n;
      if (ra[i]!.end < rb[j]!.end) i += 1;
      else j += 1;
    }
    return total;
  };
  return { 4: overlapFor(4), 6: overlapFor(6) };
};

/**
 * Complement of `excluded` inside the routable universe for `family`:
 * `0.0.0.0/0` for IPv4, `2000::/3` (Global Unicast) for IPv6.
 */
export const complementCidrs = (
  excluded: readonly string[],
  family: CidrFamily,
): string[] => {
  const universe = family === 4 ? ["0.0.0.0/0"] : ["2000::/3"];
  return subtractCidrs(universe, excluded).cidrs;
};

type TrieNode = {
  start: bigint;
  depth: number;
  left: TrieNode | null;
  right: TrieNode | null;
  parent: TrieNode | null;
  isLeaf: boolean;
  collapsed: boolean;
  dead: boolean;
  hasForbidden: boolean;
  routes: number;
  coveredSpace: bigint;
  version: number;
};

type HeapEntry = {
  node: TrieNode;
  version: number;
  extra: bigint;
  saved: bigint;
};

class CollapseMinHeap {
  private readonly items: HeapEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  push(entry: HeapEntry): void {
    this.items.push(entry);
    this.siftUp(this.items.length - 1);
  }

  pop(): HeapEntry | null {
    if (this.items.length === 0) return null;
    const top = this.items[0]!;
    const last = this.items.pop()!;
    if (this.items.length > 0) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  private less(a: HeapEntry, b: HeapEntry): boolean {
    const lhs = a.extra * b.saved;
    const rhs = b.extra * a.saved;
    if (lhs !== rhs) return lhs < rhs;
    if (a.saved !== b.saved) return a.saved > b.saved;
    if (a.node.start !== b.node.start) return a.node.start < b.node.start;
    return a.node.depth > b.node.depth;
  }

  private siftUp(index: number): void {
    let i = index;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(this.items[i]!, this.items[parent]!)) break;
      const tmp = this.items[i]!;
      this.items[i] = this.items[parent]!;
      this.items[parent] = tmp;
      i = parent;
    }
  }

  private siftDown(index: number): void {
    let i = index;
    const count = this.items.length;
    while (true) {
      let best = i;
      const left = i * 2 + 1;
      const right = i * 2 + 2;
      if (left < count && this.less(this.items[left]!, this.items[best]!)) best = left;
      if (right < count && this.less(this.items[right]!, this.items[best]!)) best = right;
      if (best === i) break;
      const tmp = this.items[i]!;
      this.items[i] = this.items[best]!;
      this.items[best] = tmp;
      i = best;
    }
  }
}

export type SupernetOptions = {
  /** Stop collapsing a family once its route count reaches this floor. */
  maxRoutes?: Partial<Record<CidrFamily, number>>;
  /** Maximum extra non-forbidden addresses gap-filling may add, per family. */
  maxExtraIps?: Partial<Record<CidrFamily, bigint>>;
  /**
   * Maximum share (0..1) of the non-forbidden routable universe that
   * gap-filling may add, per family. Ignored if `maxExtraIps` is set for the
   * same family.
   */
  maxExtraShare?: Partial<Record<CidrFamily, number>>;
  /** Minimum prefix length eligible to collapse (default 0). */
  minCollapsePrefix?: Partial<Record<CidrFamily, number>>;
};

export type SupernetResult = {
  cidrs: string[];
  losslessCount: number;
  compactedCount: number;
  countsByFamily: Record<CidrFamily, number>;
  extraSpace: Record<CidrFamily, bigint>;
  collateralShare: Record<CidrFamily, number>;
};

const collapseFamily = (
  family: CidrFamily,
  prefixes: AlignedPrefix[],
  forbidden: Range[],
  options: SupernetOptions,
): { cidrs: string[]; extraSpace: bigint; collateralShare: number } => {
  if (prefixes.length === 0) {
    return { cidrs: [], extraSpace: 0n, collateralShare: 0 };
  }

  const bits = FAMILY_BITS[family];
  const fullEnd = (1n << BigInt(bits)) - 1n;
  const minPrefix = options.minCollapsePrefix?.[family] ?? 0;
  const targetRoutes = options.maxRoutes?.[family] ?? 0;

  // Non-forbidden routable universe for collateral share budgeting:
  // IPv4: 2^32 minus forbidden; IPv6: Global Unicast 2000::/3 minus forbidden.
  const universeCidrs = family === 4 ? ["0.0.0.0/0"] : ["2000::/3"];
  const forbiddenCidrs = forbidden.flatMap((range) =>
    rangeToCidrs(family, range.start, range.end),
  );
  const nonForbiddenUniverse = measureCidrSpace(
    subtractCidrs(universeCidrs, forbiddenCidrs).cidrs,
  )[family];

  let extraBudget: bigint | null = options.maxExtraIps?.[family] ?? null;
  const shareOption = options.maxExtraShare?.[family];
  if (extraBudget === null && shareOption !== undefined) {
    const share = Math.max(0, Math.min(1, shareOption));
    const bps = BigInt(Math.round(share * 1_000_000));
    extraBudget = (nonForbiddenUniverse * bps) / 1_000_000n;
  }

  const root: TrieNode = {
    start: 0n,
    depth: 0,
    left: null,
    right: null,
    parent: null,
    isLeaf: false,
    collapsed: false,
    dead: false,
    hasForbidden: hasRangeOverlap(0n, fullEnd, forbidden),
    routes: 0,
    coveredSpace: 0n,
    version: 0,
  };

  for (const block of prefixes) {
    let node = root;
    for (let depth = 0; depth < block.prefix; depth += 1) {
      const bitPos = BigInt(bits - 1 - depth);
      const bit = (block.start >> bitPos) & 1n;
      const half = 1n << bitPos;
      if (bit === 0n) {
        if (!node.left) {
          const st = node.start;
          node.left = {
            start: st,
            depth: depth + 1,
            left: null,
            right: null,
            parent: node,
            isLeaf: false,
            collapsed: false,
            dead: false,
            hasForbidden: node.hasForbidden
              ? hasRangeOverlap(st, st + half - 1n, forbidden)
              : false,
            routes: 0,
            coveredSpace: 0n,
            version: 0,
          };
        }
        node = node.left;
      } else {
        if (!node.right) {
          const st = node.start + half;
          node.right = {
            start: st,
            depth: depth + 1,
            left: null,
            right: null,
            parent: node,
            isLeaf: false,
            collapsed: false,
            dead: false,
            hasForbidden: node.hasForbidden
              ? hasRangeOverlap(st, st + half - 1n, forbidden)
              : false,
            routes: 0,
            coveredSpace: 0n,
            version: 0,
          };
        }
        node = node.right;
      }
    }
    node.isLeaf = true;
    node.routes = 1;
    node.coveredSpace = 1n << BigInt(bits - block.prefix);
  }

  const heap = new CollapseMinHeap();
  const walkStack: Array<[TrieNode, boolean]> = [[root, false]];
  while (walkStack.length > 0) {
    const [node, visited] = walkStack.pop()!;
    if (!visited) {
      walkStack.push([node, true]);
      if (node.left) walkStack.push([node.left, false]);
      if (node.right) walkStack.push([node.right, false]);
      continue;
    }
    if (node.isLeaf) continue;
    node.routes = (node.left?.routes ?? 0) + (node.right?.routes ?? 0);
    node.coveredSpace =
      (node.left?.coveredSpace ?? 0n) + (node.right?.coveredSpace ?? 0n);
    if (
      !node.hasForbidden &&
      node.depth >= minPrefix &&
      node.left !== null &&
      node.right !== null &&
      node.routes > 1
    ) {
      const nodeSize = 1n << BigInt(bits - node.depth);
      heap.push({
        node,
        version: node.version,
        extra: nodeSize - node.coveredSpace,
        saved: BigInt(node.routes - 1),
      });
    }
  }

  const markDead = (startNode: TrieNode): void => {
    const stack: TrieNode[] = [startNode];
    while (stack.length > 0) {
      const current = stack.pop()!;
      if (current.dead) continue;
      current.dead = true;
      if (current.left && !current.left.collapsed) stack.push(current.left);
      if (current.right && !current.right.collapsed) stack.push(current.right);
    }
  };

  let currentRoutes = root.routes;
  let extraSpace = 0n;

  while (heap.size > 0) {
    if (targetRoutes > 0 && currentRoutes <= targetRoutes) break;
    const entry = heap.pop()!;
    const node = entry.node;
    if (
      node.dead ||
      node.collapsed ||
      entry.version !== node.version ||
      node.routes <= 1
    ) {
      continue;
    }

    const nodeSize = 1n << BigInt(bits - node.depth);
    const deltaSpace = nodeSize - node.coveredSpace;
    if (extraBudget !== null && extraSpace + deltaSpace > extraBudget) {
      continue;
    }

    const deltaRoutes = node.routes - 1;
    node.collapsed = true;
    if (node.left) markDead(node.left);
    if (node.right) markDead(node.right);
    node.routes = 1;
    node.coveredSpace = nodeSize;
    extraSpace += deltaSpace;
    currentRoutes -= deltaRoutes;

    let parent = node.parent;
    while (parent) {
      parent.routes -= deltaRoutes;
      parent.coveredSpace += deltaSpace;
      if (
        !parent.hasForbidden &&
        parent.depth >= minPrefix &&
        !parent.dead &&
        !parent.collapsed &&
        parent.routes > 1
      ) {
        parent.version += 1;
        const parentSize = 1n << BigInt(bits - parent.depth);
        heap.push({
          node: parent,
          version: parent.version,
          extra: parentSize - parent.coveredSpace,
          saved: BigInt(parent.routes - 1),
        });
      }
      parent = parent.parent;
    }
  }

  // Collect resulting prefixes in canonical address order (left before right).
  const out: string[] = [];
  const collectStack: TrieNode[] = [root];
  while (collectStack.length > 0) {
    const node = collectStack.pop()!;
    if (node.isLeaf || node.collapsed) {
      out.push(`${formatAddress(family, node.start)}/${node.depth}`);
      continue;
    }
    if (node.right) collectStack.push(node.right);
    if (node.left) collectStack.push(node.left);
  }

  const collateralShare =
    nonForbiddenUniverse === 0n
      ? 0
      : Number((extraSpace * 100_000n) / nonForbiddenUniverse) / 100_000;

  return { cidrs: out, extraSpace, collateralShare };
};

/**
 * Compact `include` into fewer aligned CIDR prefixes by filling small gaps
 * between nearby blocks, under two strict guarantees:
 *
 *   1. ZERO addresses from `forbidden` ever enter the result.
 *   2. 100% of `include \ forbidden` remains covered.
 *
 * Uses a binary prefix trie and collapses the cheapest safe supernets first
 * (minimum extra addresses per route saved) until optional route or collateral
 * budgets are reached.
 */
export const supernetCidrsSafely = (
  include: readonly string[],
  forbidden: readonly string[],
  options: SupernetOptions = {},
): SupernetResult => {
  const cleaned = subtractCidrs(include, forbidden);
  const losslessByFamily = rangesByFamily(cleaned.cidrs);
  const forbiddenByFamily = rangesByFamily(forbidden);

  const prefixes4 = losslessByFamily[4].flatMap((range) =>
    rangeToAlignedPrefixes(4, range.start, range.end),
  );
  const prefixes6 = losslessByFamily[6].flatMap((range) =>
    rangeToAlignedPrefixes(6, range.start, range.end),
  );
  const losslessCount = prefixes4.length + prefixes6.length;

  const v4 = collapseFamily(4, prefixes4, forbiddenByFamily[4], options);
  const v6 = collapseFamily(6, prefixes6, forbiddenByFamily[6], options);
  const cidrs = [...v4.cidrs, ...v6.cidrs];

  return {
    cidrs,
    losslessCount,
    compactedCount: cidrs.length,
    countsByFamily: { 4: v4.cidrs.length, 6: v6.cidrs.length },
    extraSpace: { 4: v4.extraSpace, 6: v6.extraSpace },
    collateralShare: { 4: v4.collateralShare, 6: v6.collateralShare },
  };
};

const expandToMaximalSafe = (
  family: CidrFamily,
  prefixes: AlignedPrefix[],
  protectedRanges: Range[],
  minPrefix: number,
): string[] => {
  if (prefixes.length === 0) return [];
  const bits = FAMILY_BITS[family];
  const fullEnd = (1n << BigInt(bits)) - 1n;

  type ExpandNode = {
    start: bigint;
    depth: number;
    left: ExpandNode | null;
    right: ExpandNode | null;
    isLeaf: boolean;
    hasProtected: boolean;
  };

  const root: ExpandNode = {
    start: 0n,
    depth: 0,
    left: null,
    right: null,
    isLeaf: false,
    hasProtected: hasRangeOverlap(0n, fullEnd, protectedRanges),
  };

  for (const block of prefixes) {
    let node = root;
    for (let depth = 0; depth < block.prefix; depth += 1) {
      const bitPos = BigInt(bits - 1 - depth);
      const bit = (block.start >> bitPos) & 1n;
      const half = 1n << bitPos;
      if (bit === 0n) {
        if (!node.left) {
          const st = node.start;
          node.left = {
            start: st,
            depth: depth + 1,
            left: null,
            right: null,
            isLeaf: false,
            hasProtected: node.hasProtected
              ? hasRangeOverlap(st, st + half - 1n, protectedRanges)
              : false,
          };
        }
        node = node.left;
      } else {
        if (!node.right) {
          const st = node.start + half;
          node.right = {
            start: st,
            depth: depth + 1,
            left: null,
            right: null,
            isLeaf: false,
            hasProtected: node.hasProtected
              ? hasRangeOverlap(st, st + half - 1n, protectedRanges)
              : false,
          };
        }
        node = node.right;
      }
    }
    node.isLeaf = true;
  }

  // Collapse every maximal subtree that contains zero protected addresses
  // (including single-leaf branches) so the complement `0.0.0.0/0 \ expanded`
  // avoids deep prefix splitting around small isolated holes.
  const out: string[] = [];
  const stack: ExpandNode[] = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    if (node.isLeaf || (!node.hasProtected && node.depth >= minPrefix)) {
      out.push(`${formatAddress(family, node.start)}/${node.depth}`);
      continue;
    }
    if (node.right) stack.push(node.right);
    if (node.left) stack.push(node.left);
  }
  return subtractCidrs(out, []).cidrs;
};

/**
 * Expand an exclusion list (such as Russian GeoIP prefixes) to the maximal
 * aligned supernets that contain zero addresses from `protectedTargets`.
 *
 * Unlike `supernetCidrsSafely`, this also widens isolated single prefixes up to
 * their widest protected-free ancestor so that taking the complement
 * (`0.0.0.0/0 \ expanded`) yields a minimal route table (~1,000 routes).
 */
export const expandExclusionsSafely = (
  exclusions: readonly string[],
  protectedTargets: readonly string[],
  options: Pick<SupernetOptions, "minCollapsePrefix"> = {},
): SupernetResult => {
  const cleaned = subtractCidrs(exclusions, protectedTargets);
  const losslessByFamily = rangesByFamily(cleaned.cidrs);
  const protectedByFamily = rangesByFamily(protectedTargets);

  const prefixes4 = losslessByFamily[4].flatMap((range) =>
    rangeToAlignedPrefixes(4, range.start, range.end),
  );
  const prefixes6 = losslessByFamily[6].flatMap((range) =>
    rangeToAlignedPrefixes(6, range.start, range.end),
  );
  const losslessCount = prefixes4.length + prefixes6.length;

  const v4 = expandToMaximalSafe(
    4,
    prefixes4,
    protectedByFamily[4],
    options.minCollapsePrefix?.[4] ?? 0,
  );
  const v6 = expandToMaximalSafe(
    6,
    prefixes6,
    protectedByFamily[6],
    options.minCollapsePrefix?.[6] ?? 0,
  );
  const cidrs = [...v4, ...v6];
  const baseSpace = measureCidrSpace(cleaned.cidrs);
  const finalSpace = measureCidrSpace(cidrs);

  return {
    cidrs,
    losslessCount,
    compactedCount: cidrs.length,
    countsByFamily: { 4: v4.length, 6: v6.length },
    extraSpace: {
      4: finalSpace[4] - baseSpace[4],
      6: finalSpace[6] - baseSpace[6],
    },
    collateralShare: { 4: 0, 6: 0 },
  };
};
