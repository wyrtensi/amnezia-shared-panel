import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// The editor for a key's operator-only note. It was extracted out of the admin
// Users page when an administrator's own key card started showing the same
// note: one field, one explanation, one dialog. These assertions came with it.
const source = readFileSync(
  fileURLToPath(new URL("./key-internal-name-dialog.tsx", import.meta.url)),
  "utf8",
);

describe("internalNameOutcome", () => {
  it("saves a typed note", async () => {
    const { internalNameOutcome } = await import("./key-internal-name-dialog");
    expect(internalNameOutcome("kochkina, replaced 04.09", null)).toEqual({
      action: "save",
      internalName: "kochkina, replaced 04.09",
    });
  });

  it("treats an emptied field as a deliberate clear, not as nothing", async () => {
    // The `window.prompt` this replaced distinguished "" from `null`; the
    // dialog has to keep the two apart itself, because clearing a note is an
    // edit the API records and cancelling is not.
    const { internalNameOutcome } = await import("./key-internal-name-dialog");
    expect(internalNameOutcome("", "kochkina")).toEqual({
      action: "clear",
      internalName: "",
    });
    expect(internalNameOutcome("   ", "kochkina")).toEqual({
      action: "clear",
      internalName: "",
    });
  });

  it("posts nothing when the draft ends up as what the key already had", async () => {
    // Cancel, and equally an editor opened only to read the note: neither may
    // write an audit event saying the note was changed.
    const { internalNameOutcome } = await import("./key-internal-name-dialog");
    expect(internalNameOutcome("kochkina", "kochkina").action).toBe("none");
    expect(internalNameOutcome(" kochkina ", "kochkina").action).toBe("none");
    expect(internalNameOutcome("", null).action).toBe("none");
    expect(internalNameOutcome("", "").action).toBe("none");
  });

  it("caps the note at the column's own 80 characters", async () => {
    // varchar(80) in migration 0026 and `.max(80)` in the contract. A longer
    // note is refused by the API, so it must never leave the dialog.
    const { internalNameOutcome, INTERNAL_NAME_MAX } = await import(
      "./key-internal-name-dialog"
    );
    expect(INTERNAL_NAME_MAX).toBe(80);
    const outcome = internalNameOutcome("x".repeat(120), null);
    expect(outcome.action).toBe("save");
    expect(outcome.internalName).toHaveLength(80);
  });
});

describe("Internal name dialog", () => {
  it("is the panel's own dialog, not a browser prompt", () => {
    // The defect this fixes: a grey system box with no room to say who sees
    // the field. A later edit reaching for window.prompt again would look
    // harmless and lose the whole explanation.
    expect(source).not.toContain("window.prompt(");
    expect(source).not.toContain("next.slice(0, 80)");
  });

  it("says what the field is for and that only administrators see it", () => {
    expect(source).toContain("users.internalNameDesc");
    expect(source).toContain("users.internalNamePrivateTitle");
    expect(source).toContain("users.internalNamePrivate");
  });

  it("shows which key is being annotated, by device label and node", () => {
    expect(source).toContain("users.internalNameFor");
    expect(source).toMatch(/\{deviceLabel\}[\s\S]{0,300}\{nodeName\}/);
  });

  it("shows the 80-character cap rather than truncating in silence", () => {
    expect(source).toContain("maxLength={INTERNAL_NAME_MAX}");
    expect(source).toContain("users.internalNameCapped");
    expect(source).toMatch(/\{draft\.length\} \/ \{INTERNAL_NAME_MAX\}/);
  });

  it("keeps save, clear and cancel as three separate answers", () => {
    // Cancel closes and posts nothing; Clear posts the empty string, which the
    // API stores as NULL; Save posts the draft. Routing all three through
    // internalNameOutcome is what keeps "cleared" from collapsing into
    // "unchanged".
    expect(source).toMatch(/onClick=\{\(\) => void submit\(""\)\}/);
    expect(source).toMatch(/onClick=\{\(\) => void submit\(draft\)\}/);
    expect(source).toMatch(
      /variant="outline" disabled=\{saving\} onClick=\{onClose\}/,
    );
    expect(source).toContain("users.internalNameClear");
    expect(source).toMatch(/if \(decided\.action === "none"\) \{/);
  });

  it("draws a set note as a framed chip, not a third muted line", () => {
    // Shared by both surfaces so the note reads the same on an admin's own key
    // card as it does on the Users page. As muted italics under a device label
    // it read as a subtitle of that label and was squeezed to two characters
    // at 375px.
    expect(source).not.toContain(
      'className="truncate text-xs italic text-muted-foreground/80"',
    );
    expect(source).toMatch(/<NotebookPen className="size-3 shrink-0/);
    expect(source).toMatch(/export function InternalNameChip/);
  });
});
