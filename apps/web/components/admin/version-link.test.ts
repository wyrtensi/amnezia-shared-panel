import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The version is a link now, and the two properties that make that link safe
// and quiet — a new tab with `rel="noreferrer"`, and a badge that still reads
// as a badge — are invisible to the type checker.
const read = (name: string) =>
  readFileSync(fileURLToPath(new URL(name, import.meta.url)), "utf8");

const link = read("./version-link.tsx");
const badge = read("./version-badge.tsx");
const card = read("./panel-update-card.tsx");

describe("VersionLink", () => {
  it("opens the repository in a new tab without leaking the referrer", () => {
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noreferrer"');
  });

  it("stays a version badge rather than a loud link", () => {
    // Muted, mono, and only underlined on hover/focus — no link colour.
    expect(link).toContain('cn("font-mono", className)');
    expect(link).toContain("hover:underline");
  });

  it("renders plain text when the build carries no repository", () => {
    expect(link).toMatch(/if \(!href\) \{[\s\S]{0,200}<span/);
  });
});

describe("the places a version is shown", () => {
  it("both render through VersionLink, so they cannot disagree", () => {
    for (const source of [badge, card]) {
      expect(source).toContain('from "@/components/admin/version-link"');
      expect(source).toMatch(/<VersionLink\s/);
    }
  });

  it("carries the repository through the update card's version payload", () => {
    expect(card).toContain("repositoryUrl?: string | null");
  });
});
