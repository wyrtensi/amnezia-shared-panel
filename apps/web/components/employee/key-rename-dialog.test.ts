import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./key-rename-dialog.tsx", import.meta.url)),
  "utf8",
);

describe("renameKeyOutcome", () => {
  it("trims and saves a typed label", async () => {
    const { renameKeyOutcome } = await import("./key-rename-dialog");
    expect(renameKeyOutcome("  New Laptop  ", "Laptop")).toEqual({
      canSave: true,
      deviceLabel: "New Laptop",
    });
  });

  it("refuses an empty draft -- this dialog renames, it does not clear", async () => {
    const { renameKeyOutcome } = await import("./key-rename-dialog");
    expect(renameKeyOutcome("", "Laptop").canSave).toBe(false);
    expect(renameKeyOutcome("   ", "Laptop").canSave).toBe(false);
    expect(renameKeyOutcome("   ", null).canSave).toBe(false);
  });

  it("refuses a draft that is unchanged once trimmed", async () => {
    // Opening the dialog and saving without typing anything must not fire a
    // rename request, let alone one that reads as a rotate-worthy edit.
    const { renameKeyOutcome } = await import("./key-rename-dialog");
    expect(renameKeyOutcome("Laptop", "Laptop").canSave).toBe(false);
    expect(renameKeyOutcome(" Laptop ", "Laptop").canSave).toBe(false);
  });

  it("caps the label at the column's own 80 characters", async () => {
    const { renameKeyOutcome, RENAME_LABEL_MAX } = await import(
      "./key-rename-dialog"
    );
    expect(RENAME_LABEL_MAX).toBe(80);
    const outcome = renameKeyOutcome("x".repeat(120), "Laptop");
    expect(outcome.canSave).toBe(true);
    expect(outcome.deviceLabel).toHaveLength(80);
  });
});

describe("Key rename dialog", () => {
  it("is a real dialog, not window.confirm or window.prompt", () => {
    expect(source).not.toContain("window.confirm(");
    expect(source).not.toContain("window.prompt(");
  });

  it("computes whether a re-issue is coming with the same composer the config export uses", () => {
    // The warning must never be a blanket assumption: it has to match what
    // `defaultService.ts`'s `getKeyConfig` would actually compose, or the
    // dialog could threaten a re-issue nothing will trigger, or stay quiet
    // about one that is coming.
    expect(source).toContain('from "@amnezia/contracts"');
    expect(source).toMatch(/composeKeyDisplayName\(\{[\s\S]{0,120}label: deviceLabel/);
    expect(source).toMatch(
      /composeKeyDisplayName\(\{[\s\S]{0,120}label: outcome\.deviceLabel/,
    );
  });

  it("shows the re-issue warning only when the composed name actually differs", () => {
    expect(source).toContain("willReissue ?");
    expect(source).toContain("keyCard.renameReissueTitle");
    expect(source).toContain("keyCard.renameReissueBody");
  });

  it("explains the quiet case instead of just omitting the warning", () => {
    // A user who renames a key and sees no warning at all, with no
    // explanation, has no way to tell that from a bug.
    expect(source).toContain("keyCard.renameQuietTitle");
    expect(source).toContain("keyCard.renameQuietBody");
  });

  it("disables Save until there is something worth sending", () => {
    expect(source).toMatch(/disabled=\{saving \|\| !outcome\.canSave\}/);
  });
});
