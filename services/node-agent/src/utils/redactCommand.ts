/**
 * Strip secret material out of a string that is about to reach a log.
 *
 * The agent builds file writes as `echo '<base64>' | base64 -d > …`
 * (utils/shellWrite.ts). For writeWgConfig that base64 is the WHOLE awg0.conf,
 * interface PrivateKey included. On failure the connection helpers reject with
 * a message built from the command AND from the ExecException — and Node's
 * exec error message is `Command failed: <the full command>\n<stderr>`, so the
 * payload is present twice. fastifyErrorHandler then writes that message to
 * appLogger, which AGENTS.md forbids for private keys and VPN configs.
 *
 * Matching is on the base64 run itself, not on the `echo '...'` syntax around
 * it, because buildCommand() re-quotes the command as
 * `docker exec <c> sh -lc '<cmd with ' -> '\''>'`: the raw command and the
 * error carry different quoting but the same payload.
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
