import { describe, expect, it, vi } from "vitest";
import {
  LOOKUP_TIMEOUT_MS,
  normalizePublicHost,
  resolvePublicIp,
  type HostLookup,
} from "./publicAddress.js";

const noLookup: HostLookup = () => Promise.resolve([]);

describe("normalizePublicHost", () => {
  it("trims and lowercases a reported host", () => {
    expect(normalizePublicHost("  VPN.Example.COM ")).toBe("vpn.example.com");
  });

  it("returns null for a missing, empty or oversized host", () => {
    expect(normalizePublicHost(undefined)).toBeNull();
    expect(normalizePublicHost("   ")).toBeNull();
    expect(normalizePublicHost("a".repeat(254))).toBeNull();
  });
});

describe("resolvePublicIp", () => {
  it("returns an IPv4 literal unchanged without looking it up", async () => {
    const lookup = vi.fn(noLookup);
    await expect(resolvePublicIp("203.0.113.10", lookup)).resolves.toBe(
      "203.0.113.10",
    );
    expect(lookup).not.toHaveBeenCalled();
  });

  it("returns null for an IPv6 literal without looking it up", async () => {
    // IPv4 only: publicIp is typed as IPv4 in the contract because the client
    // endpoint line has no bracketing, so an IPv6 literal is not storable.
    const lookup = vi.fn(noLookup);
    await expect(resolvePublicIp("2001:db8::1", lookup)).resolves.toBeNull();
    expect(lookup).not.toHaveBeenCalled();
  });

  it("prefers the first IPv4 record of a DNS name", async () => {
    const lookup = vi.fn<HostLookup>(() =>
      Promise.resolve([
        { address: "2001:db8::1", family: 6 },
        { address: "203.0.113.10", family: 4 },
        { address: "203.0.113.11", family: 4 },
      ]),
    );
    await expect(resolvePublicIp("vpn.example.com", lookup)).resolves.toBe(
      "203.0.113.10",
    );
    expect(lookup).toHaveBeenCalledWith("vpn.example.com");
  });

  it("returns null for a host that only has an AAAA record", async () => {
    // IPv4 only, by decision. An IPv6 address would be shown but could not be
    // used: the client endpoint line is built without brackets, so the rest of
    // the stack cannot carry it. "Unresolved" is the honest answer.
    const lookup = vi.fn<HostLookup>(() =>
      Promise.resolve([{ address: "2001:db8::1", family: 6 }]),
    );
    await expect(resolvePublicIp("v6.example.com", lookup)).resolves.toBeNull();
  });

  it("returns null when the lookup fails or yields nothing", async () => {
    await expect(
      resolvePublicIp("nx.example.com", () =>
        Promise.reject(new Error("ENOTFOUND")),
      ),
    ).resolves.toBeNull();
    await expect(
      resolvePublicIp("empty.example.com", () => Promise.resolve([])),
    ).resolves.toBeNull();
  });

  it("returns null when the lookup exceeds the timeout", async () => {
    vi.useFakeTimers();
    try {
      const pending = resolvePublicIp(
        "slow.example.com",
        () =>
          new Promise<Array<{ address: string; family: number }>>(() => {
            // A resolver that never answers.
          }),
      );
      await vi.advanceTimersByTimeAsync(LOOKUP_TIMEOUT_MS + 1);
      await expect(pending).resolves.toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});
