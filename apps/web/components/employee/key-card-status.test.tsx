import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { StatusBadge } from "@/components/status-badge";
import { TooltipProvider } from "@/components/ui/tooltip";
import { keyBadgeState } from "@/lib/node-reachability";

import { KeyGuideButton } from "./key-card";

const blocked = { state: "blocked" as const, since: "2026-11-12T09:11:00.000Z", sinceText: "12.11 10:11" };

describe("KeyGuideButton", () => {
  const html = renderToStaticMarkup(
    <TooltipProvider>
      <KeyGuideButton onClick={() => undefined} />
    </TooltipProvider>,
  );

  it("hides the word by the card's width, not the window's", () => {
    expect(html).toMatch(/<span class="@max-\[22rem\]:hidden">Инструкция<\/span>/);
    // A viewport breakpoint here would leave the word on a narrow grid column.
    expect(html).not.toMatch(/\b(sm|md|lg|max-sm|max-md):hidden/);
  });

  it("keeps the button named when only the icon shows", () => {
    expect(html).toContain('aria-label="Инструкция"');
  });
});

describe("key status badge", () => {
  const badge = (state: string, reachability?: typeof blocked) =>
    renderToStaticMarkup(<StatusBadge value={keyBadgeState(state, reachability)} />);

  it("reads Блок for an active key on a blocked server, never cut", () => {
    const html = badge("active", blocked);
    expect(html).toContain(">Блок<");
    expect(html).toContain("whitespace-nowrap");
    expect(html).toContain("shrink-0");
  });

  it("leaves other states alone on a blocked server", () => {
    expect(badge("provisioning", blocked)).not.toContain("Блок");
    expect(badge("failed", blocked)).not.toContain("Блок");
    expect(badge("active")).toContain(">Активен<");
  });
});
