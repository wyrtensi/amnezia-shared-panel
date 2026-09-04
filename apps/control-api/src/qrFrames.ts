/**
 * AmneziaVPN's own QR envelope — the format this panel serves for the client's
 * in-app scanner.
 *
 * The panel's other QR carries the text `vpn://<base64url>`, which a camera app
 * hands to the OS as a deep link; it is still served (see ConfigFormat `qr` and
 * `qr-svg`) because a camera app cannot read this envelope at all. AmneziaVPN's
 * *in-app* scanner is the mirror image: it does not read a `vpn://` URL, it
 * expects a bare base64url blob framed with an 8-byte header and a magic number,
 * and it reassembles several such frames into the config. A plain `vpn://`
 * symbol fails that check no matter how large or crisp it is.
 *
 * Source of truth: services/node-agent/src/helpers/amneziaQr.ts (lines 44-85)
 * and services/node-agent/src/contracts/app/app.contract.ts (lines 140,143,146).
 * That service is outside the pnpm workspace and cannot be imported from here,
 * so the format is duplicated on purpose; qrFrames.test.ts pins the constants
 * and the byte layout so the two copies cannot drift silently.
 *
 * This ONE format serves both client apps. DefaultVPN — the client that installs
 * from the Russian App Store — is a live fork of amnezia-client
 * (github.com/amnezia-vpn/DefaultVPN@dev) whose scanner is byte-identical:
 * `client/core/qrCodeUtils.cpp:8-17` writes magic 1984, a uint8 chunk count and
 * index, a uint32BE length and an 850-byte chunk, base64url-encoded, and
 * `client/ui/controllers/importController.cpp:643-669` reads exactly that back.
 * It also shares the limitation: `vpn://` is stripped only on the paste/import
 * path (`importController.cpp:156`), never on the scan path, so a `vpn://`
 * symbol is unreadable to its scanner too. There is therefore no separate
 * DefaultVPN format to build; the panel shows the same code under two labels.
 *
 * Frame layout, big-endian, matching Qt's QDataStream on the client side:
 *   int16  magic (1984 == 0x07C0)
 *   uint8  chunks count
 *   uint8  chunk index
 *   uint32 chunk length
 *   ...    chunk bytes
 * The chunked body is the *decoded* link payload — `uint32BE(uncompressed
 * length) + deflate(json)`, which is Qt's qCompress wire format — not the
 * `vpn://` string.
 */

export const QR_FRAME_MAGIC = 1984;

/**
 * Payload bytes per frame. 850 is the client's own constant, and it is the only
 * value this repo can prove the client accepts, because it is what the node
 * agent already emits. It splits the production payload (860 decoded bytes)
 * into two frames, which is why the UI has two display modes at all. Any value
 * >= 860 would make a real key a single static code with the identical module
 * count (measured: 113 either way); moving there needs the on-device check in
 * this plan's Task 0 step 5 first.
 */
export const QR_FRAME_CHUNK_BYTES = 850;

export const QR_FRAME_HEADER_BYTES = 8;

/** The chunk counter and index are one byte each. */
const QR_FRAME_MAX_FRAMES = 255;

const toBase64Url = (buffer: Buffer): string =>
  buffer
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");

/** Decode `vpn://<base64url>` into the raw bytes the client reassembles. */
export const decodeVpnLinkBytes = (vpnLink: string): Buffer => {
  const payload = vpnLink.trim().replace(/^vpn:\/\//i, "");
  const data = payload
    ? Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64")
    : Buffer.alloc(0);
  if (!data.length) {
    throw new Error("VPN link carries no payload");
  }
  return data;
};

/** One frame: the 8-byte header followed by its chunk. */
export const serializeQrFrame = (
  chunksCount: number,
  chunkIndex: number,
  chunk: Buffer,
): Buffer => {
  const header = Buffer.alloc(QR_FRAME_HEADER_BYTES);
  header.writeInt16BE(QR_FRAME_MAGIC, 0);
  header.writeUInt8(chunksCount, 2);
  header.writeUInt8(chunkIndex, 3);
  header.writeUInt32BE(chunk.length, 4);
  return Buffer.concat([header, chunk]);
};

/**
 * Build the QR *texts* — not images — for the AmneziaVPN in-app scanner, in the
 * order they must be shown. Rendering is Task 3's job, through `renderKeyQr`,
 * so the frames inherit the same quiet zone and crisp-edges SVG as every other
 * code the panel serves.
 */
export const buildQrFrameTexts = (
  vpnLink: string,
  options: { chunkBytes?: number } = {},
): string[] => {
  const chunkBytes = options.chunkBytes ?? QR_FRAME_CHUNK_BYTES;
  const data = decodeVpnLinkBytes(vpnLink);
  const chunksCount = Math.ceil(data.length / chunkBytes);
  if (chunksCount > QR_FRAME_MAX_FRAMES) {
    throw new Error("Config needs more QR frames than the format allows");
  }

  const frames: string[] = [];
  for (let offset = 0; offset < data.length; offset += chunkBytes) {
    const chunkIndex = Math.floor(offset / chunkBytes);
    const chunk = data.subarray(offset, offset + chunkBytes);
    frames.push(toBase64Url(serializeQrFrame(chunksCount, chunkIndex, chunk)));
  }
  return frames;
};
