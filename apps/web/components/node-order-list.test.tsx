import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { messages } from "@/lib/i18n/messages";
import { NodeOrderList } from "./node-order-list";

describe("NodeOrderList", () => {
  it("renders endpoint names, addresses, badges, and responsive wrapping classes", () => {
    const html = renderToStaticMarkup(
      <NodeOrderList
        nodes={[
          { id: "ep-1", name: "Edge-1", address: "192.0.2.10", enabled: true },
          { id: "ep-2", name: "Edge-2", address: "192.0.2.20", enabled: false },
        ]}
        order={["ep-1", "ep-2"]}
        recommended={["ep-1"]}
        onChange={() => {}}
      />,
    );

    expect(html).toContain("Edge-1");
    expect(html).toContain("192.0.2.10");
    expect(html).toContain("Edge-2");
    expect(html).toContain("192.0.2.20");
    expect(html).toContain(messages.ru["nodes.endpointDisabled"].toLowerCase());
    expect(html).toContain(messages.ru["wizard.recommended"]);
    expect(html).toContain(`${messages.ru["policy.moveUp"]}: Edge-1`);
    expect(html).toContain(`${messages.ru["policy.moveDown"]}: Edge-2`);
    expect(html).toContain("flex-wrap");
    expect(html).toContain("sm:flex-nowrap");
    expect(html).toContain("sm:w-auto");
  });
});
