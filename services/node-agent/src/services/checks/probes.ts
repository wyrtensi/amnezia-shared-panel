import { lookup as lookupWithCallback } from "node:dns";
import type { LookupAddress, LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";
import { Agent, fetch as undiciFetch, type Response as ProbeResponse } from "undici";

import { ProbeOutcome } from "./assertions";

/**
 * The probe registry.
 *
 * A probe is "what to do"; the assertions in `assertions.ts` are "what must be
 * true of the result". Adding a kind - DNS, TCP, TLS - is an entry here plus a
 * variant in `checkProbeSchema` on the panel side. Nothing else changes,
 * because a check is stored as a document rather than as columns.
 *
 * `http` is the only kind today, and the split is the point: the runner does
 * not know what an HTTP response is, so a future TCP probe does not have to
 * pretend to have a status code.
 */

/** At most this much body is read, then the stream is cancelled. */
export const MAX_BODY_BYTES = 64 * 1024;

/** The hard ceiling on a probe, whatever the check asked for. */
export const MAX_TIMEOUT_MS = 15_000;

export class ProbeRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProbeRefusedError";
  }
}

export class UnsupportedProbeError extends Error {
  constructor(readonly probeKind: string) {
    super(`unsupported probe kind: ${probeKind}`);
    this.name = "UnsupportedProbeError";
  }
}

/**
 * Take the IPv6 wrapper off an address that carries an IPv4 one inside it.
 *
 * ipaddr.js matches the wrapper prefix before it looks at the address inside,
 * so `::ffff:169.254.169.254` classifies as `ipv4Mapped` and never as
 * `linkLocal`. Classifying the wrapper is classifying the envelope; the
 * address that decides the answer is the one inside it.
 *
 * NAT64 (`64:ff9b::/96`, the only prefix ipaddr.js reports as `rfc6052`) is
 * unwrapped rather than refused on purpose: a node on an IPv6-only network
 * behind NAT64 receives these for ordinary public sites, and refusing the
 * range would break every check on such a host.
 */
const unwrapEmbeddedIpv4 = (
  parsed: ipaddr.IPv4 | ipaddr.IPv6,
): ipaddr.IPv4 | ipaddr.IPv6 => {
  if (parsed.kind() !== "ipv6") return parsed;
  const address = parsed as ipaddr.IPv6;
  if (address.isIPv4MappedAddress()) return address.toIPv4Address();
  if (address.range() === "rfc6052") {
    return new ipaddr.IPv4(address.toByteArray().slice(12, 16));
  }
  return address;
};

/**
 * Refuse one address unless it is plain public unicast.
 *
 * This is an ALLOW-list, and that is the point. The deny-list it replaced
 * enumerated the ranges someone thought of - and `ipv4Mapped`, `rfc6052`,
 * `6to4` and `teredo` were not among them, so every internal address had a
 * spelling that walked straight through. A range nobody has considered yet
 * must fail closed, not open.
 */
export const assertPublicIp = (address: string, hostname: string): void => {
  if (!ipaddr.isValid(address)) {
    throw new ProbeRefusedError(`${hostname} resolved to ${address}`);
  }
  const range = unwrapEmbeddedIpv4(ipaddr.parse(address)).range();
  if (range !== "unicast") {
    throw new ProbeRefusedError(
      `${hostname} resolves to a ${range} address (${address})`,
    );
  }
};

/**
 * Refuse a target that resolves inside the node's own network.
 *
 * A check is an admin-supplied string that this process fetches from the
 * node's network namespace, which is exactly the shape of an SSRF primitive:
 * the docker socket, the AWG containers and the host's metadata service all sit
 * behind addresses the panel cannot otherwise reach. The contract already
 * refuses `localhost` and friends by name; this refuses them by ADDRESS, which
 * is the half a hostname cannot be trusted to tell you.
 */
export const assertPublicAddress = async (
  hostname: string,
  resolve: (host: string) => Promise<string[]> = async (host) => {
    const records = await lookup(host, { all: true });
    return records.map((record) => record.address);
  },
): Promise<void> => {
  const literal = ipaddr.isValid(hostname)
    ? [hostname]
    : await resolve(hostname);
  if (literal.length === 0) {
    throw new ProbeRefusedError(`${hostname} does not resolve`);
  }
  for (const address of literal) {
    assertPublicIp(address, hostname);
  }
};

type LookupCallback = (
  error: NodeJS.ErrnoException | null,
  address: string | LookupAddress[],
  family?: number,
) => void;

/** The shape `net.connect` calls, which is what undici hands the socket. */
type LookupFn = (
  hostname: string,
  options: LookupOptions,
  callback: LookupCallback,
) => void;

/**
 * Put the guard on the dial itself.
 *
 * `assertPublicAddress` resolves the name and the HTTP client then resolves it
 * again, on its own. Two lookups with nothing pinning one to the other is a
 * rebinding window: the answer that passed the check is not necessarily the
 * answer the socket connects to. This wraps the resolver the connection
 * actually uses, so the address that is approved is the address that is dialled.
 *
 * Both answer shapes are handled because `net.connect` asks for one or all
 * depending on the Node version, and a hook that understands only one of them
 * would wave the other straight through.
 */
export const createGuardedLookup =
  (inner: LookupFn = lookupWithCallback as unknown as LookupFn): LookupFn =>
  (hostname, options, callback) => {
    inner(hostname, options, (error, address, family) => {
      if (error) {
        callback(error, address, family);
        return;
      }
      const answers = Array.isArray(address)
        ? address.map((entry) => entry.address)
        : [address];
      try {
        for (const answer of answers) assertPublicIp(answer, hostname);
      } catch (refusal) {
        callback(refusal as NodeJS.ErrnoException, address, family);
        return;
      }
      callback(null, address, family);
    });
  };

/**
 * One pool for every probe, carrying the guarded resolver.
 *
 * An IP literal never reaches this hook - `net.connect` skips the resolver when
 * the host is already an address - so the per-hop check in `runHttpProbe` is
 * not redundant with it. The two cover different inputs: this one covers a name
 * whose answer changes between check and connect, that one covers a redirect
 * pointing straight at an address.
 *
 * Probes call undici's own `fetch` rather than the global one because a
 * dispatcher only works with the client it came from: Node bundles its own
 * undici, and handing it an Agent from this package fails at the first request
 * with `invalid onRequestStart method`. Using the pair from one package also
 * keeps the guard off the base image's undici version, which would otherwise
 * decide whether it runs at all.
 */
const probeDispatcher = new Agent({
  connect: { lookup: createGuardedLookup() },
});

/** Read at most `MAX_BODY_BYTES`, then stop pulling from the socket. */
const readCappedBody = async (response: ProbeResponse): Promise<{
  body: string;
  bytes: number;
}> => {
  const stream = response.body;
  if (!stream) return { body: "", bytes: 0 };
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done || !value) break;
      const remaining = MAX_BODY_BYTES - bytes;
      if (remaining <= 0) break;
      const chunk =
        value.byteLength <= remaining ? value : value.subarray(0, remaining);
      chunks.push(chunk);
      bytes += chunk.byteLength;
      if (bytes >= MAX_BODY_BYTES) break;
    }
  } finally {
    // Cancel rather than drain: the point of the cap is not to receive the
    // rest, and a page a node checks twice a day can be megabytes.
    await reader.cancel().catch(() => undefined);
  }
  return { body: Buffer.concat(chunks).toString("utf8"), bytes };
};

export type ProbeRunner = (
  probe: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<ProbeOutcome>;

/**
 * How many redirects a probe will follow.
 *
 * Lower than undici's own 20, because a check needing more than a handful of
 * hops describes a site that is broken rather than one that is blocked, and
 * every hop is another request this node makes on someone else's say-so.
 */
const MAX_REDIRECTS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Parse one hop against the one before it, refusing a scheme we do not speak. */
const parseHop = (value: string, base?: URL): URL => {
  let parsed: URL;
  try {
    parsed = new URL(value, base);
  } catch {
    throw new ProbeRefusedError(`not a URL: ${value.slice(0, 80)}`);
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ProbeRefusedError(`not an http(s) URL: ${parsed.protocol}`);
  }
  return parsed;
};

/** Drop an interim body: the redirect is the answer, the page attached to it is not. */
const discardBody = async (response: ProbeResponse): Promise<void> => {
  await response.body?.cancel().catch(() => undefined);
};

const runHttpProbe: ProbeRunner = async (probe, signal) => {
  const url = typeof probe.url === "string" ? probe.url : "";
  const method = probe.method === "HEAD" ? "HEAD" : "GET";
  let target = parseHop(url);

  for (let hop = 0; ; hop += 1) {
    // Every hop, not just the first. The admin chooses the hostname; the far
    // end chooses where it redirects, so a guard that runs once guards the one
    // address nobody needed it for.
    await assertPublicAddress(target.hostname);

    const response = await undiciFetch(target, {
      method,
      // `manual` so the chain is ours to walk. `follow` handed it to undici,
      // which cannot know an address has to be checked before it is dialled.
      redirect: "manual",
      signal,
      dispatcher: probeDispatcher,
      headers: {
        // A default Node user agent is itself a signal to the far end. This says
        // what it is without claiming to be a browser: a check that lies about
        // its client is a check whose result does not describe what a user sees.
        "user-agent": "amnezia-node-agent-check/1",
        accept: "text/html,application/xhtml+xml,*/*;q=0.8",
      },
    });

    const location = response.headers.get("location");
    if (REDIRECT_STATUSES.has(response.status) && location) {
      await discardBody(response);
      if (hop >= MAX_REDIRECTS) {
        throw new ProbeRefusedError(
          `too many redirects (over ${MAX_REDIRECTS}) from ${url.slice(0, 80)}`,
        );
      }
      target = parseHop(location, target);
      continue;
    }

    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => {
      headers[key.toLowerCase()] = value;
    });

    const { body, bytes } =
      method === "HEAD"
        ? { body: "", bytes: 0 }
        : await readCappedBody(response);

    return {
      status: response.status,
      // The last address actually requested, which is what `finalUrlContains`
      // asks about. `response.url` is no longer that once the chain is ours.
      finalUrl: target.toString(),
      headers,
      body,
      bodyBytes: bytes,
    };
  }
};

export const PROBE_RUNNERS: Record<string, ProbeRunner> = {
  http: runHttpProbe,
};

/** What this agent advertises, and the only kinds the runner will execute. */
export const SUPPORTED_PROBE_KINDS = Object.keys(PROBE_RUNNERS).sort();

export const runProbe = async (
  probe: Record<string, unknown>,
  timeoutMs: number,
): Promise<ProbeOutcome> => {
  const kind = typeof probe.kind === "string" ? probe.kind : "";
  const run = PROBE_RUNNERS[kind];
  if (!run) throw new UnsupportedProbeError(kind || "(missing)");
  const bounded = Math.min(
    Math.max(Number.isFinite(timeoutMs) ? timeoutMs : MAX_TIMEOUT_MS, 1_000),
    MAX_TIMEOUT_MS,
  );
  return run(probe, AbortSignal.timeout(bounded));
};
