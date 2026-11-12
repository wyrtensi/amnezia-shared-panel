import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { NodeView } from "@/lib/types";

import { ServerStatusList } from "./server-status-list";

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
        node("amster4", {
          recommended: true,
          reachability: { state: "ok", since: null, sinceText: null },
        }),
        node("london2", {
          reachability: {
            state: "blocked",
            since: "2026-11-12T09:11:00.000Z",
            sinceText: "12.11 10:11",
          },
        }),
        node("kz2", { reachability: { state: "unknown", since: null, sinceText: null } }),
      ]}
    />,
  );

  it("puts a blocked server first and says since when, in red", () => {
    expect(html.indexOf("london2")).toBeLessThan(html.indexOf("amster4"));
    expect(html).toContain('<span class="block text-xs text-destructive">с 12.11 10:11</span>');
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
});
