import { describe, expect, it, vi } from "vitest";
import type { Requester } from "@/lib/bridge-api";
import {
  adoptNodeEgressMode,
  createNodeEgressIp,
  deleteNodeEgressIp,
  formatEntryExit,
  listNodeEgressIps,
  reassignKeyEndpoint,
  setNodeEgressMode,
  swapNodeEgressIp,
  updateNodeEgressIp,
  verifyNodeEgressIp,
} from "./egress-api";

describe("formatEntryExit", () => {
  it("formats entry -> exit when distinct, and collapses identical or missing sides", () => {
    expect(formatEntryExit("192.0.2.10", "198.51.100.20")).toBe(
      "192.0.2.10 → 198.51.100.20",
    );
    expect(formatEntryExit("192.0.2.10", "192.0.2.10")).toBe("192.0.2.10");
    expect(formatEntryExit("192.0.2.10", null)).toBe("192.0.2.10");
    expect(formatEntryExit(null, "198.51.100.20")).toBe("198.51.100.20");
    expect(formatEntryExit("", undefined)).toBeNull();
  });
});

describe("egress API wrappers", () => {
  it("dispatches expected paths, methods, and JSON payloads", async () => {
    const calls: Array<{ path: string; init?: RequestInit }> = [];
    const spy = vi.fn();
    const request: Requester = <T,>(path: string, init?: RequestInit) => {
      spy(path, init);
      calls.push({ path, init });
      return Promise.resolve({} as T);
    };

    await listNodeEgressIps(request, "node-1");
    await createNodeEgressIp(request, "node-1", {
      ipv4: "198.51.100.20",
      dnsPrimary: "1.1.1.1",
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      allowAsEntry: false,
      enabled: true,
    });
    await updateNodeEgressIp(request, "node-1", "ip-1", { label: "DE-2" });
    await deleteNodeEgressIp(request, "node-1", "ip-1");
    await swapNodeEgressIp(request, "node-1", "ip-1", { ipv4: "198.51.100.21" });
    await verifyNodeEgressIp(request, "node-1", "ip-1");
    await setNodeEgressMode(request, "node-1", { mode: "routed", blockSmtp: true });
    await adoptNodeEgressMode(request, "node-1");
    await reassignKeyEndpoint(request, "key-1", "ep-2");

    expect(calls.map((c) => [c.path, c.init?.method ?? "GET"])).toEqual([
      ["/api/admin/nodes/node-1/egress-ips", "GET"],
      ["/api/admin/nodes/node-1/egress-ips", "POST"],
      ["/api/admin/nodes/node-1/egress-ips/ip-1", "PATCH"],
      ["/api/admin/nodes/node-1/egress-ips/ip-1", "DELETE"],
      ["/api/admin/nodes/node-1/egress-ips/ip-1/swap", "POST"],
      ["/api/admin/nodes/node-1/egress-ips/ip-1/verify", "POST"],
      ["/api/admin/nodes/node-1/egress-mode", "PUT"],
      ["/api/admin/nodes/node-1/egress-mode/adopt", "POST"],
      ["/api/admin/keys/key-1/reassign-endpoint", "POST"],
    ]);
  });
});
