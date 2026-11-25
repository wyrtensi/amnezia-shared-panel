import http from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";

import { EgressService } from "@/services/egress";
import { DesiredState, HostNetworkReport } from "@/types/egress";

const sampleReport = (): HostNetworkReport => ({
  daemonVersion: "1.2.0",
  observedMode: "routed",
  egressState: "routed_active",
  bridgeName: "br-awg-egress",
  bridgePresent: true,
  awg3ContainerIpv4: "172.30.0.2",
  tunnelSubnetConflict: false,
  ipv4Addresses: [
    {
      ipv4: "198.51.100.10",
      cidr: "198.51.100.10/24",
      interfaceName: "eth0",
      detectedGatewayIpv4: "198.51.100.1",
    },
  ],
  exits: [
    {
      ipv4: "198.51.100.10",
      hostState: "active",
      txBytes: 1024,
      txPackets: 8,
    },
  ],
  observedAt: "2026-11-25T10:00:00Z",
});

const sampleState = (): DesiredState => ({
  schemaVersion: 1,
  blockSmtp: true,
  isolatePrivate: true,
  exits: [
    {
      id: "exit-1",
      ipv4: "198.51.100.10",
      dnsPrimary: "1.1.1.1",
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      enabled: true,
    },
  ],
  peers: [
    {
      tunnelIpv4: "10.90.0.2",
      exitIp: "198.51.100.10",
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      enabled: true,
    },
  ],
});

const startMockSocketServer = async (
  handler: http.RequestListener,
): Promise<{ socketPath: string; close: () => Promise<void> }> => {
  const isWin = process.platform === "win32";
  const dir = isWin ? "" : await mkdtemp(join(tmpdir(), "egress-svc-"));
  const socketPath = isWin
    ? `\\\\.\\pipe\\amnezia-egress-test-${process.pid}-${randomUUID()}`
    : join(dir, "egressd.sock");

  const srv = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    srv.once("error", reject);
    srv.listen(socketPath, () => resolve());
  });

  return {
    socketPath,
    close: async () => {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      if (dir) {
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
};

describe("EgressService", () => {
  const cleanups: Array<() => Promise<void>> = [];

  afterEach(async () => {
    while (cleanups.length > 0) {
      const fn = cleanups.pop();
      if (fn) await fn();
    }
  });

  it("degrades silently to null for passive calls and 503 for control calls when socket is missing", async () => {
    const missingPath =
      process.platform === "win32"
        ? `\\\\.\\pipe\\amnezia-missing-${randomUUID()}`
        : "/tmp/non-existent-amnezia-egressd.sock";
    const service = new EgressService({ socketPath: missingPath });

    expect(service.isConfigured()).toBe(true);
    await expect(service.getReport()).resolves.toBeNull();
    await expect(service.getState()).resolves.toBeNull();
    await expect(
      service.upsertPeer(sampleState().peers[0]),
    ).resolves.toBeNull();
    await expect(service.removePeer("10.90.0.2")).resolves.toBeNull();

    await expect(service.applyState(sampleState())).rejects.toMatchObject({
      statusCode: 503,
    });
    await expect(
      service.verifyExit({
        egressIpv4: "198.51.100.10",
        probeUrl: "https://example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(
      service.runHttpCheck({
        egressIpv4: "198.51.100.10",
        url: "https://example.com",
      }),
    ).rejects.toMatchObject({ statusCode: 503 });
    await expect(service.switchMode("routed")).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("disables cleanly when socketPath is empty string", async () => {
    const service = new EgressService({ socketPath: "" });
    expect(service.isConfigured()).toBe(false);
    await expect(service.getReport()).resolves.toBeNull();
    await expect(service.applyState(sampleState())).rejects.toMatchObject({
      statusCode: 503,
    });
  });

  it("performs report, state, peer, verify, http-check, and switch-mode calls over Unix/pipe socket", async () => {
    const seen: Array<{ method?: string; url?: string; body: unknown }> = [];
    let switchStatus = 200;
    let switchOk = true;

    const srv = await startMockSocketServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => chunks.push(c));
      req.on("end", () => {
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? JSON.parse(raw) : undefined;
        seen.push({ method: req.method, url: req.url, body });

        res.setHeader("Content-Type", "application/json");
        if (req.method === "GET" && req.url === "/v1/report") {
          res.end(JSON.stringify(sampleReport()));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/state") {
          res.end(JSON.stringify(sampleState()));
          return;
        }
        if (req.method === "PUT" && req.url === "/v1/state") {
          res.end(JSON.stringify({ ok: true, report: sampleReport() }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/peers/upsert") {
          res.end(JSON.stringify({ ok: true, report: sampleReport() }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/peers/remove") {
          res.end(JSON.stringify({ ok: true, report: sampleReport() }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/verify-exit") {
          res.end(
            JSON.stringify({
              ok: true,
              egressIpv4: "198.51.100.10",
              observedIp: "198.51.100.10",
              ipMatch: true,
              httpLatencyMs: 25,
              dnsOk: true,
              dnsServer: "1.1.1.1:53",
              dnsLatencyMs: 12,
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/checks/http") {
          res.end(
            JSON.stringify({
              status: 200,
              finalUrl: "https://198.51.100.50/",
              body: "ok-body",
              headers: { "content-type": "text/plain" },
              latencyMs: 31,
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/switch-mode") {
          res.statusCode = switchStatus;
          res.end(
            JSON.stringify({
              ok: switchOk,
              report: sampleReport(),
              ...(switchOk ? {} : { error: "health gate failed" }),
            }),
          );
          return;
        }
        res.statusCode = 404;
        res.end("{}");
      });
    });
    cleanups.push(srv.close);

    const service = new EgressService({ socketPath: srv.socketPath });

    const report = await service.getReport();
    expect(report?.egressState).toBe("routed_active");

    const state = await service.getState();
    expect(state?.exits[0].ipv4).toBe("198.51.100.10");

    const applied = await service.applyState(sampleState());
    expect(applied.ok).toBe(true);

    await expect(
      service.upsertPeer(sampleState().peers[0]),
    ).resolves.toMatchObject({ ok: true });
    await expect(service.removePeer("10.90.0.2")).resolves.toMatchObject({
      ok: true,
    });

    const verify = await service.verifyExit({
      egressIpv4: "198.51.100.10",
      probeUrl: "https://ip.example",
      dnsServer: "1.1.1.1",
    });
    expect(verify).toMatchObject({
      ok: true,
      ipMatch: true,
      dnsOk: true,
      observedIp: "198.51.100.10",
    });

    const httpRes = await service.runHttpCheck({
      egressIpv4: "198.51.100.10",
      url: "https://198.51.100.50/",
    });
    expect(httpRes).toMatchObject({ status: 200, body: "ok-body" });

    const switched = await service.switchMode("routed");
    expect(switched.ok).toBe(true);

    switchStatus = 409;
    switchOk = false;
    await expect(service.switchMode("masquerade")).rejects.toMatchObject({
      statusCode: 409,
    });

    expect(seen.map((item) => `${item.method} ${item.url}`)).toEqual([
      "GET /v1/report",
      "GET /v1/state",
      "PUT /v1/state",
      "POST /v1/peers/upsert",
      "POST /v1/peers/remove",
      "POST /v1/verify-exit",
      "POST /v1/checks/http",
      "POST /v1/switch-mode",
      "POST /v1/switch-mode",
    ]);
  });
});
