import {
  createCipheriv,
  createDecipheriv,
  createHmac,
  randomBytes,
} from "node:crypto";
import type {
  KeyState,
  PortalPolicy,
  PortalPolicyOverride,
} from "@amnezia/contracts";

export * from "./client.js";
export * from "./schema.js";

export type EncryptionKeyring = Readonly<Record<number, Buffer>>;

export type EncryptedSecret = {
  keyVersion: number;
  ciphertext: string;
  nonce: string;
  authTag: string;
};

const quotaStates = new Set<KeyState>([
  "provisioning",
  "active",
  "disabled",
]);

const getEncryptionKey = (
  keyring: EncryptionKeyring,
  keyVersion: number,
): Buffer => {
  const key = keyring[keyVersion];
  if (!key) {
    throw new Error(`Unknown encryption key version: ${keyVersion}`);
  }
  if (key.byteLength !== 32) {
    throw new Error("AES-256-GCM keys must contain exactly 32 bytes");
  }
  return key;
};

export const encryptSecret = (
  plaintext: string,
  keyring: EncryptionKeyring,
  keyVersion: number,
): EncryptedSecret => {
  const key = getEncryptionKey(keyring, keyVersion);
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);

  return {
    keyVersion,
    ciphertext: ciphertext.toString("base64"),
    nonce: nonce.toString("base64"),
    authTag: cipher.getAuthTag().toString("base64"),
  };
};

export const decryptSecret = (
  encrypted: EncryptedSecret,
  keyring: EncryptionKeyring,
): string => {
  const key = getEncryptionKey(keyring, encrypted.keyVersion);
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(encrypted.nonce, "base64"),
  );
  decipher.setAuthTag(Buffer.from(encrypted.authTag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(encrypted.ciphertext, "base64")),
    decipher.final(),
  ]).toString("utf8");
};

export const countQuotaKeys = (states: readonly KeyState[]): number =>
  states.reduce((count, state) => count + Number(quotaStates.has(state)), 0);

export const effectiveKeyLimit = (
  globalLimit: number,
  userOverride: number | null | undefined,
): number => userOverride ?? globalLimit;

export const resolvePortalPolicy = (
  globalPolicy: PortalPolicy,
  userOverride: PortalPolicyOverride | null | undefined,
): PortalPolicy => ({ ...globalPolicy, ...(userOverride ?? {}) });

export const deterministicPeerLabel = (
  keyId: string,
  nodeLabelSecret: Buffer,
): string => {
  if (nodeLabelSecret.byteLength < 32) {
    throw new Error("Node label secrets must contain at least 32 bytes");
  }
  const digest = createHmac("sha256", nodeLabelSecret)
    .update(keyId, "utf8")
    .digest("base64url")
    .slice(0, 22);
  return `ap_${digest}`;
};

export const trafficDelta = (
  previous: number,
  current: number,
): { delta: number; reset: boolean } =>
  current >= previous
    ? { delta: current - previous, reset: false }
    : { delta: current, reset: true };
