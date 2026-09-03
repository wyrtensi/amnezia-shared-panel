import { lookup } from "node:dns/promises";
import { isIpLiteral, isIpv4Literal } from "@amnezia/contracts";

/** Upper bound for one DNS lookup so a stuck resolver cannot stall the poll. */
export const LOOKUP_TIMEOUT_MS = 5_000;

const MAX_HOST_LENGTH = 253;

export type HostLookup = (
  host: string,
) => Promise<Array<{ address: string; family: number }>>;

/**
 * Normalise the host a node-agent reported as its SERVER_PUBLIC_HOST. Null
 * for an agent that does not report one (pre-publicHost builds) or reports
 * something unusable, so an old agent leaves the columns null instead of
 * breaking the poll.
 */
export const normalizePublicHost = (
  value: string | undefined,
): string | null => {
  const host = (value ?? "").trim().toLowerCase();
  if (host.length === 0 || host.length > MAX_HOST_LENGTH) return null;
  return host;
};

/**
 * Resolve a reported host to a single IPv4 address: the host itself when it is
 * an IPv4 literal, otherwise the first A record. AAAA records are ignored — the
 * client endpoint line is built as `host:port` with no bracketing, so an IPv6
 * address could not be used by the rest of the stack and showing one would only
 * mislead. Any failure — NXDOMAIN, resolver error, timeout, empty answer,
 * IPv6-only host — yields null so the poll still succeeds and the UI shows the
 * host as unresolved.
 */
export const resolvePublicIp = async (
  host: string,
  lookupImpl: HostLookup = (name) => lookup(name, { all: true }),
): Promise<string | null> => {
  // An IPv4 literal is its own answer. An IPv6 literal is an IP but not a
  // storable one (the contract types publicIp as IPv4), so it resolves to null
  // like any other host without a usable A record — and asking the resolver
  // about a literal would be pointless either way.
  if (isIpLiteral(host)) return isIpv4Literal(host) ? host : null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error("DNS lookup timed out")),
      LOOKUP_TIMEOUT_MS,
    );
  });
  try {
    const records = await Promise.race([lookupImpl(host), timeout]);
    return records.find((record) => record.family === 4)?.address ?? null;
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
};

/** Production resolver bound to the system resolver. */
export const createPublicIpResolver =
  (): ((host: string) => Promise<string | null>) =>
  (host) =>
    resolvePublicIp(host);
