import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const migrationsDir = join(import.meta.dirname, "../migrations");
const seedFile = readdirSync(migrationsDir).find((name) =>
  name.endsWith("_seed_service_checks.sql"),
);
const seed = readFileSync(join(migrationsDir, seedFile!), "utf8");

/** The JSON assertion arrays, as the migration writes them. */
const assertionBlocks = seed.match(/\[\{"type"[\s\S]*?\]'::jsonb/g) ?? [];

describe("the seeded service checks", () => {
  it("seeds Google Flow with the verified route marker", () => {
    expect(seed).toContain("https://labs.google/fx/tools/flow/");
    expect(seed).toContain("unsupported-country");
  });

  it("seeds NotebookLM asserting on the redirect query parameter", () => {
    expect(seed).toContain("https://notebooklm.google.com/");
    expect(seed).toContain("location=unsupported");
  });

  it("seeds Gemini with the success marker measured on the working page", () => {
    // Overturns the earlier reading, which concluded from the blocked page
    // ALONE that Gemini was uncheckable. Diffing the blocked page against a
    // working one gives conversation-container: 0 occurrences against 20.
    expect(seed).toContain("https://gemini.google.com/");
    expect(seed).toContain("conversation-container");
    expect(seed).toContain("account-rejected");
  });

  it("asserts on Gemini's marker by COUNT, not by mere presence", () => {
    // 20 against 0 is the measurement. A threshold at half of it survives a
    // restyle that drops a few occurrences while still separating the pages,
    // and it is the reason the count assertion type exists at all.
    expect(seed).toMatch(
      /"type":"bodyOccurrencesAtLeast","value":"conversation-container","count":10/,
    );
  });

  it("never asserts on input-area-container", () => {
    // Present on BOTH pages (58 blocked / 86 working), so as a positive
    // assertion it is green from a blocked node and as a negative one it is red
    // from a working one. It is a near-miss of a good marker - it sits one word
    // from "above-input-area", which IS discriminating - which is why this is a
    // test and not only a comment. If it ever fires, change the seeded value;
    // never loosen the pattern.
    for (const block of assertionBlocks) {
      expect(block).not.toContain("input-area-container");
    }
    expect(assertionBlocks).toHaveLength(3);
  });

  it("does not leave the Gemini check enabled after calibration", () => {
    // 0022 seeds it enabled; 0023 turns it off, because a live calibration
    // found every one of its markers absent from the SERVED page - they exist
    // only in the DOM a browser builds. The seed is deliberately left as it
    // was written rather than edited: an applied migration is history, and the
    // reasoning for the change belongs in the change.
    const disable = readFileSync(
      join(
        migrationsDir,
        readdirSync(migrationsDir).find((name) =>
          name.endsWith("_disable_gemini_check.sql"),
        )!,
      ),
      "utf8",
    );
    expect(disable).toMatch(/UPDATE "node_service_checks"/);
    expect(disable).toMatch(/"enabled" = false/);
    expect(disable).toContain("Google Gemini");
    // The measurement, kept where the next person will read it.
    expect(disable).toMatch(/conversation-container\s+0/);
  });

  it("gives all three the 12-hour period and re-runs safely", () => {
    expect(seed.match(/43200/g)).toHaveLength(3);
    expect(seed).toContain("ON CONFLICT");
  });

  it("seeds only assertion types the node-agent implements", () => {
    // A seeded check the fleet cannot run would show `error` on every node from
    // the day it is installed, which reads as "the service is down".
    const supported = new Set([
      "statusIn",
      "bodyContains",
      "bodyOmits",
      "bodyContainsAll",
      "bodyContainsAny",
      "bodyOccurrencesAtLeast",
      "bodyBytesAtLeast",
      "finalUrlContains",
      "finalUrlOmits",
      "headerContains",
    ]);
    const used = [...seed.matchAll(/"type":"(\w+)"/g)].map((match) => match[1]);
    expect(used.length).toBeGreaterThan(0);
    for (const type of used) {
      expect(supported.has(type!), type).toBe(true);
    }
  });
});
