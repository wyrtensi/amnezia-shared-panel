/** Rendering of a node's public address, kept out of main.ts to be testable. */

/**
 * Shape check for an IPv4 literal, not a validator.
 *
 * The CLI declares no runtime dependencies on purpose, so it cannot call
 * `isIpv4Literal` from @amnezia/contracts (see the drift note in
 * `deviceProfiles.ts`). It does not need to: the only question asked here is
 * "would this host have needed a DNS lookup at all?", and a string shaped like
 * four dotted numbers never does. Over-accepting `999.999.999.999` only means
 * such a host is printed bare instead of flagged as unresolved — the panel
 * refuses to store it as `publicIp` either way.
 */
const IPV4_SHAPE = /^\d{1,3}(\.\d{1,3}){3}$/;

/**
 * The address clients reach a node at, as one table cell.
 *
 * `publicHost` is what the node itself reports (its SERVER_PUBLIC_HOST);
 * `publicIp` is the panel's own DNS observation, written only on a successful
 * lookup. The four states stay distinguishable because the admin node card
 * distinguishes them, and the CLI is the only production interface without a
 * browser — collapsing "resolved" and "never resolved" into a bare host would
 * hide from the terminal exactly the state the web shows loudest:
 *
 *   host null            -> "—"                    the agent has not reported
 *   name + ip            -> "name (ip)"            resolved
 *   name, no ip          -> "name (unresolved)"    lookup never succeeded
 *   ip literal (+/- ip)  -> "ip"                   nothing to resolve
 *
 * The host is the authority: an ip without a host cannot be attributed to
 * anything the node claims about itself, so it reads as "not reported".
 */
export const formatNodeAddress = (
  host: string | null,
  ip: string | null,
): string => {
  if (host === null) return "—";
  if (ip === null) {
    // An IPv4 literal needs no lookup, so a null ip is normal here. Anything
    // else is a name the panel tried and failed to resolve — say so.
    return IPV4_SHAPE.test(host) ? host : `${host} (unresolved)`;
  }
  return ip === host ? host : `${host} (${ip})`;
};

/**
 * How the PANEL reaches a node's agent — the `apiBaseUrl` half of the
 * IP-vs-DNS question. (The client half is the node's own SERVER_PUBLIC_HOST,
 * rendered by `formatNodeAddress` above; the two are independent and a node
 * can be wrong in either.) A DNS name here means the panel host resolves it
 * before every poll, and a resolver failure is indistinguishable from an
 * unhealthy node.
 *
 *   ip            an address literal, including a loopback tunnel end
 *   docker-local  a container/compose name, resolved by Docker's own DNS
 *   dns           a real hostname resolved by the panel host's resolver
 *   unknown       unparseable — reported, never thrown
 *
 * See docs/NODE-CONNECT.md, "Use the IP address, not a DNS name".
 */
export const classifyNodeHost = (
  apiBaseUrl: string,
): "ip" | "docker-local" | "dns" | "unknown" => {
  let host: string;
  try {
    host = new URL(apiBaseUrl).hostname;
  } catch {
    return "unknown";
  }
  if (!host) return "unknown";
  // `new URL` hands back an IPv6 literal still wrapped in its brackets, which
  // is the only place a colon can survive into a hostname.
  if (IPV4_SHAPE.test(host) || host.startsWith("[")) return "ip";
  // A single label (no dot) is resolved by Docker, not by public DNS; so is
  // the Docker Desktop escape hatch, which has dots but is not public either.
  if (!host.includes(".") || host === "host.docker.internal") {
    return "docker-local";
  }
  return "dns";
};
