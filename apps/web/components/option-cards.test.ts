import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(
  fileURLToPath(new URL("./option-cards.tsx", import.meta.url)),
  "utf8",
);

/**
 * The title's wrapping is decided by two numbers that never appear together in
 * one place: how much room the tick needs, and how much room the widest label
 * word needs. When the second exceeds the first the labels split mid-word --
 * "macOS MacBoo / k" -- and nothing in a desktop screenshot warns you, because
 * the tightest column in the app is the 3-up device grid inside a 576px dialog.
 * So the numbers are pinned here rather than in a comment alone.
 */
describe("option card title", () => {
  it("reserves the tick's own footprint and no more", () => {
    // The tick is `absolute right-2 w-4`, so its left edge sits 24px from the
    // card's border; the card's content box ends 15px from it (`p-3.5` plus a
    // 1px border). The title must therefore clear 9px, and it must not eat
    // more than ~16px: past that the 88.7px device column no longer fits
    // "MacBook" (69px) or "Windows" (69.5px) and `break-words` splits them.
    // `pr-5` (20px) was over that ceiling, which is the bug this pins.
    const match = source.match(
      /className="break-words pr-([\d.]+) font-medium/,
    );
    expect(match, "the title still carries a right-padding class").not.toBeNull();
    const px = Number(match![1]) * 4;
    expect(px).toBeGreaterThanOrEqual(9);
    expect(px).toBeLessThanOrEqual(16);
  });

  it("breaks inside a word only as a last resort", () => {
    // `break-words` (overflow-wrap: break-word) leaves ordinary wrapping at
    // word boundaries. `break-all` and `wrap-anywhere` do not, and either one
    // would bring back the mid-word splits regardless of how wide the column is.
    expect(source).toContain("break-words");
    expect(source).not.toMatch(/break-all|wrap-anywhere/);
  });

  it("keeps the badge out of the title row", () => {
    // A badge beside the title narrows that one card's title column and
    // misaligns the row -- the reason it was anchored to the card's bottom.
    expect(source).toContain('<span className="mt-auto pt-1">{option.badge}</span>');
  });
});
