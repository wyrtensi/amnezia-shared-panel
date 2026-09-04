import { lookup } from "node:dns/promises";
import ipaddr from "ipaddr.js";

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
    if (!ipaddr.isValid(address)) {
      throw new ProbeRefusedError(`${hostname} resolved to ${address}`);
    }
    const range = ipaddr.parse(address).range();
    if (
      range === "loopback" ||
      range === "private" ||
      range === "linkLocal" ||
      range === "uniqueLocal" ||
      range === "unspecified" ||
      range === "carrierGradeNat" ||
      range === "reserved"
    ) {
      throw new ProbeRefusedError(
        `${hostname} resolves to a ${range} address (${address})`,
      );
    }
  }
};

/** Read at most `MAX_BODY_BYTES`, then stop pulling from the socket. */
const readCappedBody = async (response: Response): Promise<{
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

const runHttpProbe: ProbeRunner = async (probe, signal) => {
  const url = typeof probe.url === "string" ? probe.url : "";
  const method = probe.method === "HEAD" ? "HEAD" : "GET";
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    throw new ProbeRefusedError(`not a URL: ${url.slice(0, 80)}`);
  }
  if (target.protocol !== "http:" && target.protocol !== "https:") {
    throw new ProbeRefusedError(`not an http(s) URL: ${target.protocol}`);
  }
  await assertPublicAddress(target.hostname);

  const response = await fetch(target, {
    method,
    redirect: "follow",
    signal,
    headers: {
      // A default Node user agent is itself a signal to the far end. This says
      // what it is without claiming to be a browser: a check that lies about
      // its client is a check whose result does not describe what a user sees.
      "user-agent": "amnezia-node-agent-check/1",
      accept: "text/html,application/xhtml+xml,*/*;q=0.8",
    },
  });

  const headers: Record<string, string> = {};
  response.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });

  const { body, bytes } =
    method === "HEAD" ? { body: "", bytes: 0 } : await readCappedBody(response);

  return {
    status: response.status,
    finalUrl: response.url || target.toString(),
    headers,
    body,
    bodyBytes: bytes,
  };
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
