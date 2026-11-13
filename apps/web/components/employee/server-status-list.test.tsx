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
});
