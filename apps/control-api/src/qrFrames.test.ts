import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  QR_FRAME_CHUNK_BYTES,
  QR_FRAME_HEADER_BYTES,
  QR_FRAME_MAGIC,
  buildQrFrameTexts,
  decodeVpnLinkBytes,
  serializeQrFrame,
} from "./qrFrames.js";

const BASE64URL =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const fakeVpnLink = (chars: number): string =>
  `vpn://${Array.from({ length: chars }, (_, i) => BASE64URL[(i * 29 + 7) % 64]).join("")}`;

const fromBase64Url = (text: string): Buffer =>
  Buffer.from(text.replace(/-/g, "+").replace(/_/g, "/"), "base64");

describe("the constants copied from the node agent", () => {
  // services/node-agent/src/contracts/app/app.contract.ts:140,143
  it("matches AmneziaVPN's own magic number and chunk size", () => {
    expect(QR_FRAME_MAGIC).toBe(1984);
    expect(QR_FRAME_CHUNK_BYTES).toBe(850);
    expect(QR_FRAME_HEADER_BYTES).toBe(8);
  });
});

describe("serializeQrFrame", () => {
  it("lays the header out exactly as the client reads it", () => {
    const frame = serializeQrFrame(3, 1, Buffer.from([0xaa, 0xbb]));

    // int16 BE magic: 1984 == 0x07C0.
    expect(frame.readInt16BE(0)).toBe(1984);
    expect(frame[0]).toBe(0x07);
    expect(frame[1]).toBe(0xc0);
    // uint8 chunks count, uint8 chunk index, uint32 BE chunk length.
    expect(frame.readUInt8(2)).toBe(3);
    expect(frame.readUInt8(3)).toBe(1);
    expect(frame.readUInt32BE(4)).toBe(2);
    expect(frame.subarray(8)).toEqual(Buffer.from([0xaa, 0xbb]));
    expect(frame.length).toBe(QR_FRAME_HEADER_BYTES + 2);
  });
});

describe("decodeVpnLinkBytes", () => {
  it("strips the scheme and base64url-decodes the payload", () => {
    // 1147 base64url chars carry floor(1147 * 6 / 8) = 860 bytes.
    expect(decodeVpnLinkBytes(fakeVpnLink(1147))).toHaveLength(860);
  });

  it("accepts a link with surrounding whitespace and any scheme case", () => {
    expect(decodeVpnLinkBytes(`  VPN://${"A".repeat(8)}  `)).toHaveLength(6);
  });

  it("refuses an empty payload", () => {
    expect(() => decodeVpnLinkBytes("vpn://")).toThrowError(
      "VPN link carries no payload",
    );
  });
});

describe("buildQrFrameTexts", () => {
  it("splits the production payload the way the node agent does", () => {
    // Measured against services/node-agent/src/helpers/amneziaQr.ts on the real
    // 1153-char link: 860 decoded bytes, chunk size 850 -> one nearly full
    // frame and one 18-byte frame.
    const frames = buildQrFrameTexts(fakeVpnLink(1147));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toHaveLength(1144);
    expect(frames[1]).toHaveLength(24);

    const first = fromBase64Url(frames[0] ?? "");
    expect(first).toHaveLength(858);
    expect(first.readInt16BE(0)).toBe(QR_FRAME_MAGIC);
    expect(first.readUInt8(2)).toBe(2); // chunks count
    expect(first.readUInt8(3)).toBe(0); // chunk index
    expect(first.readUInt32BE(4)).toBe(850);

    const second = fromBase64Url(frames[1] ?? "");
    expect(second).toHaveLength(18);
    expect(second.readUInt8(3)).toBe(1);
    expect(second.readUInt32BE(4)).toBe(10);
  });

  it("reassembles into the original bytes", () => {
    const link = fakeVpnLink(1147);
    const frames = buildQrFrameTexts(link);
    const body = Buffer.concat(
      frames.map((frame) => fromBase64Url(frame).subarray(QR_FRAME_HEADER_BYTES)),
    );

    expect(body).toEqual(decodeVpnLinkBytes(link));
  });

  it("emits one static frame when the chunk size can hold the whole payload", () => {
    // Task 0 step 5 decides whether the client accepts this. If it does, the
    // default chunk size moves to 1024 and the UI's mode switch and frame
    // controls never appear for a real key.
    const frames = buildQrFrameTexts(fakeVpnLink(1147), { chunkBytes: 1024 });

    expect(frames).toHaveLength(1);
    expect(frames[0]).toHaveLength(1158);
    const only = fromBase64Url(frames[0] ?? "");
    expect(only).toHaveLength(868); // 8-byte header + 860 payload bytes
    expect(only.readUInt8(2)).toBe(1);
    expect(only.readUInt8(3)).toBe(0);
    expect(only.readUInt32BE(4)).toBe(860);
  });

  it("never emits a frame text with a vpn:// prefix", () => {
    // The whole point: the app's scanner reads a bare base64url blob, not a URL.
    for (const frame of buildQrFrameTexts(fakeVpnLink(1147))) {
      expect(frame.startsWith("vpn://")).toBe(false);
      expect(frame).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  it("refuses more chunks than the one-byte counter can carry", () => {
    expect(() =>
      buildQrFrameTexts(fakeVpnLink(1147), { chunkBytes: 2 }),
    ).toThrowError("Config needs more QR frames than the format allows");
  });
});

// The constants above are a copy: services/node-agent is outside the pnpm
// workspace and cannot be imported from here, so nothing links the two files.
// Asserting our own literals proves only that we did not typo them today — if
// the vendored agent is updated and the client's constants move, the copy goes
// stale silently and the panel starts emitting frames the client rejects, with
// no test failing. So read the agent's source and compare. Text, not an import,
// because importing it is exactly what the workspace boundary forbids.
describe("drift against the vendored node agent", () => {
  const contractPath = fileURLToPath(
    new URL(
      "../../../services/node-agent/src/contracts/app/app.contract.ts",
      import.meta.url,
    ),
  );

  const readConstant = (name: string): number => {
    // Deliberately not a skip-if-missing: a guard that quietly stops guarding
    // is worse than no guard. If this path ever moves, the failure says so.
    const source = readFileSync(contractPath, "utf8");
    const found = new RegExp(`${name}:\\s*(\\d+)`).exec(source);
    expect(found, `${name} not found in ${contractPath}`).not.toBeNull();
    return Number(found?.[1]);
  };

  it("still uses the magic number this module writes", () => {
    expect(readConstant("MAGIC_CODE")).toBe(QR_FRAME_MAGIC);
  });

  it("still uses the chunk size this module splits on", () => {
    expect(readConstant("CHUNK_SIZE")).toBe(QR_FRAME_CHUNK_BYTES);
  });
});
