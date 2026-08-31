import { randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defaultPortalPolicy } from "@amnezia/contracts";
import {
  countQuotaKeys,
  decryptSecret,
  deterministicPeerLabel,
  effectiveKeyLimit,
  encryptSecret,
  resolvePortalPolicy,
  trafficDelta,
} from "./index.js";

describe("secret encryption", () => {
  it("round-trips a vpn config without storing plaintext", () => {
    const key = randomBytes(32);
    const plaintext = "vpn://private-import-payload";

    const encrypted = encryptSecret(plaintext, { 3: key }, 3);

    expect(encrypted.ciphertext).not.toContain(plaintext);
    expect(encrypted.nonce).not.toBe(encrypted.authTag);
    expect(decryptSecret(encrypted, { 3: key })).toBe(plaintext);
  });

  it("rejects unknown key versions and tampered ciphertext", () => {
    const key = randomBytes(32);
    const encrypted = encryptSecret("secret", { 1: key }, 1);

    expect(() => decryptSecret(encrypted, {})).toThrow(/key version/i);
    expect(() =>
      decryptSecret({ ...encrypted, ciphertext: "AAAA" }, { 1: key }),
    ).toThrow();
  });
});

describe("quota and policy", () => {
  it("counts only provisioning, active, and disabled keys", () => {
    expect(
      countQuotaKeys([
        "provisioning",
        "active",
        "disabled",
        "revoking",
        "revoked",
        "failed",
      ]),
    ).toBe(3);
  });

  it("uses a user quota override when present", () => {
    expect(effectiveKeyLimit(5, null)).toBe(5);
    expect(effectiveKeyLimit(5, 8)).toBe(8);
  });

  it("applies only explicit user policy overrides", () => {
    const resolved = resolvePortalPolicy(defaultPortalPolicy, {
      showTraffic: false,
      allowSelfRevoke: false,
    });

    expect(resolved.showTraffic).toBe(false);
    expect(resolved.allowSelfRevoke).toBe(false);
    expect(resolved.allowQrDownload).toBe(
      defaultPortalPolicy.allowQrDownload,
    );
  });
});

describe("node identity and traffic", () => {
  it("builds a deterministic opaque label without user information", () => {
    const keyId = randomUUID();
    const secret = randomBytes(32);

    const first = deterministicPeerLabel(keyId, secret);
    const second = deterministicPeerLabel(keyId, secret);

    expect(first).toBe(second);
    expect(first).toMatch(/^ap_[A-Za-z0-9_-]{22}$/);
    expect(first).not.toContain(keyId);
  });

  it("starts a new baseline when a cumulative counter resets", () => {
    expect(trafficDelta(120, 150)).toEqual({ delta: 30, reset: false });
    expect(trafficDelta(120, 4)).toEqual({ delta: 4, reset: true });
  });
});
