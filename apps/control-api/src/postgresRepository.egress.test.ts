import { describe, expect, it } from "vitest";
import {
  resolveEndpointEffectiveEgressIp,
  resolveKeyEgressInfo,
} from "./postgresRepository.js";

describe("resolveEndpointEffectiveEgressIp", () => {
  it("uses implicit IPv4 endpoint address for self-exit in routed mode", () => {
    expect(
      resolveEndpointEffectiveEgressIp({
        nodeEgressMode: "routed",
        nodePublicIp: "198.51.100.10",
        endpointAddress: "198.51.100.20",
        endpointEgressIpv4: null,
        defaultEgressIpv4: null,
      }),
    ).toBe("198.51.100.20");
  });

  it("falls back to nodePublicIp when routed implicit self-exit address is a hostname", () => {
    expect(
      resolveEndpointEffectiveEgressIp({
        nodeEgressMode: "routed",
        nodePublicIp: "198.51.100.10",
        endpointAddress: "vpn.example.com",
        endpointEgressIpv4: null,
        defaultEgressIpv4: null,
      }),
    ).toBe("198.51.100.10");
  });

  it("prefers explicit endpoint exit, then node default exit, over implicit self-exit", () => {
    expect(
      resolveEndpointEffectiveEgressIp({
        nodeEgressMode: "routed",
        nodePublicIp: "198.51.100.10",
        endpointAddress: "198.51.100.20",
        endpointEgressIpv4: "203.0.113.5",
        defaultEgressIpv4: "203.0.113.1",
      }),
    ).toBe("203.0.113.5");
    expect(
      resolveEndpointEffectiveEgressIp({
        nodeEgressMode: "routed",
        nodePublicIp: "198.51.100.10",
        endpointAddress: "198.51.100.20",
        endpointEgressIpv4: null,
        defaultEgressIpv4: "203.0.113.1",
      }),
    ).toBe("203.0.113.1");
  });
});

describe("resolveKeyEgressInfo", () => {
  it("attributes AWG 2.0 keys to masquerade on nodePublicIp even on routed nodes", () => {
    expect(
      resolveKeyEgressInfo({
        protocol: "awg2",
        nodePublicIp: "198.51.100.10",
        nodeEgressMode: "routed",
        endpointAddress: "198.51.100.20",
        endpointEgress: {
          ipv4: "203.0.113.5",
          label: "Clean",
          dnsPrimary: "9.9.9.9",
          dnsSecondary: null,
        },
        defaultEgress: null,
      }),
    ).toEqual({
      effectiveExitIp: "198.51.100.10",
      exitLabel: null,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: "1.0.0.1",
      mode: "masquerade",
    });
  });

  it("attributes AWG 3.1 implicit self-exit IPv4 when routed without explicit or default exit", () => {
    expect(
      resolveKeyEgressInfo({
        protocol: "awg3",
        nodePublicIp: "198.51.100.10",
        nodeEgressMode: "routed",
        endpointAddress: "198.51.100.20",
        endpointEgress: null,
        defaultEgress: null,
      }),
    ).toEqual({
      effectiveExitIp: "198.51.100.20",
      exitLabel: null,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: "1.0.0.1",
      mode: "routed",
    });
  });

  it("returns neutral DNS and masquerade metadata on masquerade nodes even with staged exit", () => {
    expect(
      resolveKeyEgressInfo({
        protocol: "awg3",
        nodePublicIp: "198.51.100.10",
        nodeEgressMode: "masquerade",
        endpointAddress: "198.51.100.20",
        endpointEgress: {
          ipv4: "203.0.113.5",
          label: "Staged Clean",
          dnsPrimary: "9.9.9.9",
          dnsSecondary: "149.112.112.112",
        },
        defaultEgress: null,
      }),
    ).toEqual({
      effectiveExitIp: "198.51.100.10",
      exitLabel: null,
      dnsPrimary: "1.1.1.1",
      dnsSecondary: "1.0.0.1",
      mode: "masquerade",
    });
  });
});
