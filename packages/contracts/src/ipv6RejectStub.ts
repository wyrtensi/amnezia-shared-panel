import { z } from "zod";

/**
 * Shared contracts for the per-node AWG 3.1 IPv6 active-reject stub
 * (dedicated ULA /64 + kernel `prohibit 2000::/3` -> ICMPv6 Administratively Prohibited).
 *
 * Browser-safe: uses only pure JS/BigInt (no Node built-ins) so `apps/web`
 * can import `@amnezia/contracts` in client components.
 */
export const DEFAULT_IPV6_REJECT_STUB_PREFIX = "fd6b:7c2e:4a91:9f::/64";
export const NODE_IPV6_REJECT_STUB_JOB_TYPE = "node.set-ipv6-reject-stub";

const IPV6_HOST_MASK = (1n << 64n) - 1n;
const ULA_PREFIX_SHIFT = 120n;
const ULA_LOCAL_BYTE = 0xfdn;

const parseIpv6 = (raw: string): bigint | null => {
  if (!raw || raw.includes("%") || raw.includes(".") || /\s/.test(raw)) {
    return null;
  }
  const doubleColonIndex = raw.indexOf("::");
  if (doubleColonIndex !== -1 && raw.indexOf("::", doubleColonIndex + 1) !== -1) {
    return null;
  }

  let hextets: string[];
  if (doubleColonIndex === -1) {
    hextets = raw.split(":");
    if (hextets.length !== 8) return null;
  } else {
    const leftText = raw.slice(0, doubleColonIndex);
    const rightText = raw.slice(doubleColonIndex + 2);
    const left = leftText === "" ? [] : leftText.split(":");
    const right = rightText === "" ? [] : rightText.split(":");
    const missing = 8 - (left.length + right.length);
    if (missing < 1) return null;
    hextets = [...left, ...Array<string>(missing).fill("0"), ...right];
  }

  let value = 0n;
  for (const part of hextets) {
    if (!/^[0-9a-fA-F]{1,4}$/.test(part)) return null;
    value = (value << 16n) | BigInt(Number.parseInt(part, 16));
  }
  return value;
};

const formatIpv6 = (value: bigint): string => {
  const hextets: number[] = [];
  for (let shift = 112n; shift >= 0n; shift -= 16n) {
    hextets.push(Number((value >> shift) & 0xffffn));
  }

  let bestStart = -1;
  let bestLength = 0;
  let runStart = -1;
  let runLength = 0;
  for (let i = 0; i < hextets.length; i += 1) {
    if (hextets[i] === 0) {
      if (runStart === -1) runStart = i;
      runLength += 1;
      if (runLength > bestLength) {
        bestStart = runStart;
        bestLength = runLength;
      }
    } else {
      runStart = -1;
      runLength = 0;
    }
  }

  if (bestLength < 2) {
    return hextets.map((part) => part.toString(16)).join(":");
  }

  const left = hextets
    .slice(0, bestStart)
    .map((part) => part.toString(16))
    .join(":");
  const right = hextets
    .slice(bestStart + bestLength)
    .map((part) => part.toString(16))
    .join(":");
  return `${left}::${right}`;
};

export const normalizeUla64Prefix = (raw: string): string | null => {
  const trimmed = raw.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash !== trimmed.lastIndexOf("/")) return null;
  if (trimmed.slice(slash + 1) !== "64") return null;

  const address = parseIpv6(trimmed.slice(0, slash));
  if (address === null) return null;
  if (address >> ULA_PREFIX_SHIFT !== ULA_LOCAL_BYTE) return null;
  if ((address & IPV6_HOST_MASK) !== 0n) return null;
  return `${formatIpv6(address)}/64`;
};

export const isValidUla64Prefix = (raw: string): boolean =>
  normalizeUla64Prefix(raw) !== null;

export const nodeIpv6RejectStubStateSchema = z.enum([
  "off",
  "pending",
  "active",
  "unsupported",
  "error",
]);
export type NodeIpv6RejectStubState = z.infer<typeof nodeIpv6RejectStubStateSchema>;

export const updateNodeIpv6RejectStubRequestSchema = z
  .object({
    enabled: z.boolean(),
    prefix: z
      .string()
      .trim()
      .min(1)
      .max(64)
      .refine(
        (value) => isValidUla64Prefix(value),
        "Prefix must be a canonical RFC 4193 ULA /64 inside fd00::/8",
      )
      .transform((value) => normalizeUla64Prefix(value) ?? value)
      .optional(),
  })
  .strict();

export type UpdateNodeIpv6RejectStubRequest = z.infer<
  typeof updateNodeIpv6RejectStubRequestSchema
>;

export const nodeIpv6RejectStubViewSchema = z.object({
  enabled: z.boolean(),
  prefix: z.string(),
  state: nodeIpv6RejectStubStateSchema,
  reason: z.string().nullable(),
  observedAt: z.iso.datetime().nullable(),
});

export type NodeIpv6RejectStubView = z.infer<typeof nodeIpv6RejectStubViewSchema>;
