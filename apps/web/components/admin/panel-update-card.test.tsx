import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { messages, type Lang } from "@/lib/i18n/messages";
import { formatRequestAge, PanelUpdateProgress } from "./panel-update-card";

const tFor =
  (lang: Lang) =>
  (key: string, vars?: Record<string, string | number>): string =>
    ((messages[lang] as Record<string, string>)[key] ?? key).replace(
      /\{(\w+)\}/g,
      (match, name: string) => (vars && name in vars ? String(vars[name]) : match),
    );

const base = {
  enabled: true,
  version: { version: "1", commit: null, builtAt: null },
  lastResult: null,
};
const pending = { id: "r1", requestedAt: "2026-03-01T00:00:00.000Z", requestedBy: "a" };

const render = (status: Parameters<typeof PanelUpdateProgress>[0]["status"], lang: Lang) =>
  renderToStaticMarkup(
    <PanelUpdateProgress status={status} t={tFor(lang)} lang={lang} />,
  );

describe("PanelUpdateProgress", () => {
  it("shows an unacknowledged request with its age and the next step (EN)", () => {
    const html = render(
      {
        ...base,
        pending,
        acknowledgement: "unacknowledged",
        requestAgeSeconds: 420,
        acknowledgementDeadlineSeconds: 120,
        diagnosticHint: "UPDATE_NOT_ACKNOWLEDGED",
      },
      "en",
    );
    expect(html).toContain("7 min");
    expect(html).toContain("120 s");
    expect(html).toContain("systemctl status panel-updater.path panel-updater.service");
    expect(html).toContain("scripts/repair-updater-units.sh --dry-run");
    expect(html).toContain("never retried automatically");
    expect(html).toContain("Recovery is on the host");
    expect(html).not.toContain("Update in progress");
  });

  it("is localized in Russian", () => {
    const html = render(
      {
        ...base,
        pending,
        acknowledgement: "unacknowledged",
        requestAgeSeconds: 45,
        acknowledgementDeadlineSeconds: 30,
        diagnosticHint: "UPDATE_NOT_ACKNOWLEDGED",
      },
      "ru",
    );
    expect(html).toContain("45 с");
    expect(html).toContain("сам не повторяется");
    expect(html).toContain("Исправлять нужно на хосте");
    expect(html).toContain("repair-updater-units.sh --dry-run");
  });

  it("keeps the running state for a fresh, acknowledged or legacy status", () => {
    for (const extra of [
      { acknowledgement: "pending" as const, diagnosticHint: null },
      { acknowledgement: "acknowledged" as const, diagnosticHint: null },
      {},
    ]) {
      const html = render({ ...base, pending, ...extra }, "en");
      expect(html).toContain("Update in progress");
      expect(html).not.toContain("not picked it up");
    }
  });

  it("shows running for a host-started update without a queued request", () => {
    const html = render(
      { ...base, pending: null, running: { id: "r1", startedAt: "x" }, acknowledgement: "acknowledged" },
      "en",
    );
    expect(html).toContain("Update in progress");
  });

  it("renders nothing when idle", () => {
    expect(render({ ...base, pending: null }, "en")).toBe("");
  });

  it("formats ages", () => {
    expect(formatRequestAge(5, "en")).toBe("5 s");
    expect(formatRequestAge(7200, "ru")).toBe("2 ч");
  });
});
