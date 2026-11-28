import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NodeView } from "@/lib/types";

import { ServerAddressList, ServerStatusList } from "./server-status-list";

const node = (id: string, over: Partial<NodeView> = {}): NodeView => ({
  id,
  name: id,
  protocol: "awg3",
  maxPeers: 100,
  ...over,
});

describe("ServerStatusList", () => {
  const html = renderToStaticMarkup(
    <ServerStatusList
      nodes={[
        node("Server name 2", {
          recommended: true,
          reachability: { state: "ok", since: null },
        }),
        node("Server name 5", {
          reachability: {
            state: "blocked",
            since: "2026-11-12T09:11:00.000Z",
          },
        }),
        node("Server name 4", { reachability: { state: "unknown", since: null } }),
      ]}
    />,
  );

  it("puts a blocked server first", () => {
    expect(html.indexOf("Server name 5")).toBeLessThan(html.indexOf("Server name 2"));
  });

  it("leaves the browser-zone time out of the server render", () => {
    // The server does not know the user's zone; rendering a time here would
    // mismatch on hydration. It appears once the client has hydrated.
    expect(html).not.toContain("text-destructive\">с ");
    expect(html).not.toMatch(/\d\d\.\d\d \d\d:\d\d/);
  });

  it("draws green for ok, red for blocked, grey for no data", () => {
    expect(html).toMatch(/bg-success[^>]*title="Работает"/);
    expect(html).toMatch(/bg-destructive[^>]*title="Заблокирован"/);
    expect(html).toMatch(/bg-muted-foreground\/40[^>]*title="Нет данных"/);
  });

  it("keeps the recommended label", () => {
    expect(html).toContain("Рекомендуется");
  });

  it("draws no dot when the API sends no verdict", () => {
    const bare = renderToStaticMarkup(<ServerStatusList nodes={[node("x")]} />);
    expect(bare).not.toContain("rounded-full");
  });

  it("shows only supplied address labels and statuses in the node details", () => {
    const addresses = renderToStaticMarkup(
      <ServerAddressList addresses={[
        { id: "a", ordinal: 1, name: "First address", reachability: { state: "ok", since: null } },
        { id: "b", ordinal: 2, name: "Second address", publicAddress: "192.0.2.22" },
      ]} />,
    );
    expect(addresses).toContain('aria-label="Адреса подключения"');
    expect(addresses).toContain('title="Работает"');
    expect(addresses.indexOf("First address")).toBeLessThan(addresses.indexOf("Second address"));
    expect(addresses.match(/<code/g)).toHaveLength(1);
    expect(addresses).toContain("192.0.2.22");
  });

  it("renders each endpoint directly without adding a duplicate 'via bridge' row", () => {
    const multi = renderToStaticMarkup(
      <ServerStatusList
        nodes={[
          node("Edge", {
            bridgeReachability: { state: "ok", since: null },
            publicEndpoints: [
              { id: "ep-1", ordinal: 1, name: "Edge-1", recommended: true, reachability: { state: "ok", since: null } },
              { id: "ep-2", ordinal: 2, name: "Edge-2", recommended: false, reachability: { state: "unknown", since: null } },
            ],
          }),
        ]}
      />,
    );
    expect(multi).toContain("Edge-1");
    expect(multi).toContain("Edge-2");
    expect(multi).not.toContain("через мост");
    expect(multi).not.toContain("via bridge");
  });

  it("renders per-endpoint ServiceCheckChips in ServerAddressList and keeps ServerStatusList compact", () => {
    const endpointsWithChecks = [
      {
        id: "ep-1",
        ordinal: 1,
        name: "Edge NL",
        status: { checks: [{ name: "Google Flow", state: "works" as const }] },
      },
      {
        id: "ep-2",
        ordinal: 2,
        name: "Edge NL — Clean",
        status: { checks: [{ name: "Google Flow", state: "unavailable" as const }] },
      },
    ];
    const compact = renderToStaticMarkup(
      <ServerStatusList
        nodes={[node("Edge NL", { publicEndpoints: endpointsWithChecks })]}
      />,
    );
    expect(compact).not.toContain("Google Flow");

    const detailed = renderToStaticMarkup(
      <ServerAddressList addresses={endpointsWithChecks} />,
    );
    expect(detailed).toContain("Google Flow: работает");
    expect(detailed).toContain("Google Flow: недоступен");
  });
});
