/**
 * Strip secret material out of a string that is about to reach a log.
 *
 * File contents no longer travel inside the command - they go on stdin
 * (utils/shellWrite.ts, utils/execWithInput.ts) - so the biggest source of
 * payload-in-a-log is gone by construction. What remains is what the tools
 * themselves say back: `awg-quick strip` quotes the offending line on a parse
 * error, PrivateKey included, and that stderr is what the connection helpers
 * build their rejection from. fastifyErrorHandler then writes that message to
 * appLogger, which AGENTS.md forbids for private keys and VPN configs.
 *
 * Matching is on the base64 run itself rather than on any surrounding syntax,
 * because a payload reaches a log through several shapes - raw stderr, a
 * stringified error, a command re-quoted by buildCommand() as
 * `docker exec <c> sh -lc '<cmd with ' -> '\''>'` - and only the payload is
 * common to all of them.
 */
export const REDACTED = "<redacted>";

/**
 * A run of 60+ base64 characters is an encoded payload. Real commands do not
 * reach that: the longest unbroken [A-Za-z0-9+/] run in any path the agent
 * uses is 26 characters ("/opt/amnezia/awg/wireguard"), because "_", "-", "."
 * and spaces all break the run.
 */
const BASE64_PAYLOAD = /[A-Za-z0-9+/]{60,}={0,2}/g;

/**
 * A key written out literally — a 44-character WireGuard key is below the
 * payload threshold, so catch it by its assignment. PublicKey is deliberately
 * NOT in this list: it is not secret and it is the most useful thing in the
 * log when diagnosing a peer.
 */
const KEY_ASSIGNMENT =
  /((?:Private|PreShared|Preshared|Secret)Key\s*=\s*)[A-Za-z0-9+/]{20,}={0,2}/gi;

export const redactCommand = (value: string): string =>
  value.replace(BASE64_PAYLOAD, REDACTED).replace(KEY_ASSIGNMENT, `$1${REDACTED}`);
