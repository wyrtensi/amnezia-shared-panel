import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isIPv4 } from "node:net";
import { join } from "node:path";
import { checkServerIdentity, connect } from "node:tls";

import type { FrpsTlsFailure, FrpsTlsStatus } from "./types.js";

export const FRPS_TRUST_DIRECTORY = "/etc/amnezia-bridge/frp-trust";
const FINGERPRINT = /^[a-f0-9]{64}$/;
const EXPIRY_WARNING_MS = 30 * 86_400_000;
const HANDSHAKE_TIMEOUT_MS = 1_500;

const codeOf = (error: unknown): unknown => (error as NodeJS.ErrnoException | undefined)?.code;

const trustedMode = (uid: number, mode: number) => uid === 0 && (mode & 0o022) === 0;

const readTrusted = async (dir: string, name: string, limit: number): Promise<string | null> => {
  const file = await open(join(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    .catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    });
  if (file === null) return null;
  try {
    const stat = await file.stat();
    if (!stat.isFile() || !trustedMode(stat.uid, stat.mode) || stat.size > limit) {
      throw new Error("unsafe FRP trust file");
    }
    return (await file.readFile("utf8")).trim();
  } finally {
    await file.close();
  }
};

const failureReason = (error: unknown): FrpsTlsFailure => {
  switch (codeOf(error)) {
    case "CERT_HAS_EXPIRED":
      return "expired";
    case "CERT_NOT_YET_VALID":
      return "not_yet_valid";
    case "ERR_TLS_CERT_ALTNAME_INVALID":
      return "wrong_ip";
    case "DEPTH_ZERO_SELF_SIGNED_CERT":
    case "SELF_SIGNED_CERT_IN_CHAIN":
    case "UNABLE_TO_GET_ISSUER_CERT":
    case "UNABLE_TO_GET_ISSUER_CERT_LOCALLY":
    case "UNABLE_TO_VERIFY_LEAF_SIGNATURE":
    case "CERT_UNTRUSTED":
      return "untrusted";
    case "ECONNREFUSED":
    case "ENETUNREACH":
    case "ETIMEDOUT":
      return "unreachable";
    default:
      return "handshake";
  }
};

const failed = (reason: FrpsTlsFailure): FrpsTlsStatus => ({ state: "failed", reason });

const samplePeer = (port: number, ip: string, ca: string, deployed: string | null): Promise<FrpsTlsStatus> =>
  new Promise((resolve) => {
    const socket = connect({
      host: "127.0.0.1",
      port,
      ca,
      rejectUnauthorized: true,
      // The loopback connection uses the same certificate identity as remote frpc.
      checkServerIdentity: (_host, peer) => checkServerIdentity(ip, peer),
    });
    const timer = setTimeout(() => finish(failed("unreachable")), HANDSHAKE_TIMEOUT_MS);
    const finish = (result: FrpsTlsStatus) => {
      clearTimeout(timer);
      resolve(result);
      socket.destroy();
    };
    socket.once("secureConnect", () => {
      const peer = socket.getPeerX509Certificate();
      if (!socket.authorized || !peer) return finish(failed("handshake"));
      const expiry = peer.validToDate;
      const fingerprintSha256 = peer.fingerprint256.replaceAll(":", "").toLowerCase();
      finish({
        state: "verified",
        expiresAt: expiry.toISOString(),
        expiresSoon: expiry.getTime() - Date.now() <= EXPIRY_WARNING_MS,
        fingerprintSha256,
        matchesDeployed: deployed === null ? null : deployed === fingerprintSha256,
      });
    });
    socket.once("error", (error) => finish(failed(failureReason(error))));
    socket.once("close", () => finish(failed("handshake")));
  });

export const createFrpsTlsSampler = (dir: string, port: number) => async (): Promise<FrpsTlsStatus> => {
  try {
    const trust = await lstat(dir).catch((error: unknown) => {
      if (codeOf(error) === "ENOENT") return null;
      throw error;
    });
    if (trust === null) return { state: "unconfigured" };
    if (!trust.isDirectory() || !trustedMode(trust.uid, trust.mode)) return failed("config");

    const [ca, ip, deployed] = await Promise.all([
      readTrusted(dir, "ca.crt", 64 * 1024),
      readTrusted(dir, "public-ip", 64),
      readTrusted(dir, "deployed-sha256", 128),
    ]);
    if (ca === null && ip === null && deployed === null) return { state: "unconfigured" };
    if (!ca?.includes("-----BEGIN CERTIFICATE-----") || !ip || !isIPv4(ip) ||
      (deployed !== null && !FINGERPRINT.test(deployed))) return failed("config");
    return await samplePeer(port, ip, ca, deployed);
  } catch {
    return failed("config");
  }
};
