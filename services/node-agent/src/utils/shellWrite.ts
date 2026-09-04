/**
 * Commands that write a file inside a container, reading the content from
 * stdin.
 *
 * The content deliberately does NOT appear in the command. It used to: the
 * whole file travelled as base64 inside `echo '<base64>' | base64 -d > …`,
 * which made every write one argv string and put a hard 128 KiB ceiling
 * (MAX_ARG_STRLEN) under the node - the clients table stopped fitting at about
 * 420 peers. See utils/execWithInput.ts for the measurement.
 *
 * Base64 is still the wire format on stdin rather than the raw bytes, so the
 * file lands byte-for-byte identical to what the old path produced and nothing
 * in the pipeline has to reason about encodings.
 */

/**
 * Build an atomic file write. The base64 payload goes on stdin.
 */
export const buildWriteFileCommand = (path: string): string => {
  const tmpPath = `${path}.tmp`;

  // chmod before the mv, not after: `>` creates the temp file with the shell's
  // umask (022 in these containers, so 0644) and `mv -f` replaces the target
  // together with its mode. Without this every write silently widened a state
  // file the entrypoint had created 0600, and the node's own preflight then
  // refused the next deploy - normal operation breaking the deploy path.
  return (
    `base64 -d > '${tmpPath}' && ` +
    `chmod 600 '${tmpPath}' && ` +
    `mv -f '${tmpPath}' '${path}'`
  );
};

/**
 * Build an atomic, validated, and durable WireGuard config replacement. The
 * base64 payload goes on stdin.
 */
export const buildValidatedWgConfigCommand = (
  path: string,
  stripBinary: "wg-quick" | "awg-quick",
): string => {
  const lastSlash = path.lastIndexOf("/");
  const directory = lastSlash >= 0 ? path.slice(0, lastSlash) : ".";
  const filename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const interfaceName = filename.endsWith(".conf")
    ? filename.slice(0, -".conf".length)
    : filename;
  const tmpPath = `${directory}/.${interfaceName}.tmp.conf`;

  return (
    `{ base64 -d > '${tmpPath}' && ` +
    `chmod 600 '${tmpPath}' && ` +
    `sync && ` +
    `${stripBinary} strip '${tmpPath}' > /dev/null && ` +
    `mv -f '${tmpPath}' '${path}' && ` +
    `sync; } || { rm -f '${tmpPath}'; exit 1; }`
  );
};

/**
 * The stdin payload for the two builders above.
 */
export const encodeWritePayload = (content: string): string =>
  Buffer.from(content, "utf-8").toString("base64");
