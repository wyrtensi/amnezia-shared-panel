import fs from "fs/promises";

/**
 * Largest tail this helper returns, in bytes. A failure's reason is on the
 * last lines of a spool log, so the tail - not the head - is what both
 * AgentUpdateService and CapacityService keep.
 */
export const MAX_LOG_BYTES = 64 * 1024;

/**
 * Read at most `maxBytes` from the END of `path`, in bytes rather than UTF-16
 * code units, without ever buffering more of the file than that.
 *
 * The agent runs in a 320 MiB cgroup with a 192 MiB V8 old space against a
 * steady RSS of 79-83 MiB (infra/node/compose.yaml). `fs.readFile` followed by
 * `.slice()` buffers the whole file twice first - once as a Buffer, once as a
 * V8 string - which is exactly the shape of the log a `docker pull` retrying
 * layers produces. A positional read caps memory use at `maxBytes` regardless
 * of how large the file actually is.
 *
 * Only the START of the result can land mid-character: the read ends at EOF,
 * and the host scripts publish the log atomically (mktemp + mv -f), so a
 * reader never sees a partial write there. Leading UTF-8 continuation bytes
 * are skipped so decoding never begins inside a multi-byte sequence.
 *
 * The file can shrink between stat() and read() if the publisher replaces it
 * (via mv -f), so bytesRead is load-bearing: decode only that many bytes
 * to avoid returning NUL padding as log content.
 *
 * A missing (or otherwise unreadable) file returns "" rather than throwing: a
 * node that has never run the host helper must still be able to answer a
 * status call. The handle is closed on every path once open succeeds.
 */
export const readLogTail = async (path: string, maxBytes: number): Promise<string> => {
  const handle = await fs.open(path, "r").catch(() => null);
  if (!handle) return "";

  try {
    const { size } = await handle.stat();
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);

    const { bytesRead } = await handle.read(buffer, 0, length, size - length);

    // Skip leading UTF-8 continuation bytes (10xxxxxx): a byte-oriented cut
    // can land inside a multi-byte character, and decoding from there would
    // otherwise turn the truncated half into a replacement character.
    let start = 0;
    while (start < bytesRead && (buffer[start] & 0xc0) === 0x80) {
      start += 1;
    }

    return buffer.toString("utf8", start, bytesRead);
  } catch {
    return "";
  } finally {
    await handle.close();
  }
};
