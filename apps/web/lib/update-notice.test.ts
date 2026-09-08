import { describe, expect, it } from "vitest";

import {
  SIGNATURE_MIN_LENGTH,
  shouldShowUpdateNotice,
  signatureIsEnough,
  signatureLength,
  UPDATE_NOTICE_SHOWINGS,
  updateNoticeAcksOf,
  type SignatureStroke,
} from "./update-notice";
import type { Me } from "./types";

const user = (
  overrides: Partial<Pick<Me, "role" | "policy" | "notices">> = {},
): Pick<Me, "role" | "policy" | "notices"> => ({
  role: "user",
  policy: {},
  notices: { install: 0, update: 0 },
  ...overrides,
});

/** A straight line of `length` px, as one stroke. */
const line = (length: number): SignatureStroke => [
  { x: 0, y: 0 },
  { x: length, y: 0 },
];

describe("shouldShowUpdateNotice", () => {
  it("stops a user who has never signed", () => {
    expect(shouldShowUpdateNotice({ me: user() })).toBe(true);
  });

  it("keeps asking until the showings are used up", () => {
    for (let signed = 0; signed < UPDATE_NOTICE_SHOWINGS; signed += 1) {
      expect(
        shouldShowUpdateNotice({
          me: user({ notices: { install: 0, update: signed } }),
        }),
        `signed ${signed}`,
      ).toBe(true);
    }
    expect(
      shouldShowUpdateNotice({
        me: user({ notices: { install: 0, update: UPDATE_NOTICE_SHOWINGS } }),
      }),
    ).toBe(false);
  });

  it("stays out of the way once they are", () => {
    expect(
      shouldShowUpdateNotice({ me: user({ notices: { install: 0, update: 9 } }) }),
    ).toBe(false);
  });

  it("never shows it to an administrator, at any count", () => {
    // Same exclusion the install reminder makes: an admin issues keys all day.
    // Holds even with the policy explicitly on.
    for (const update of [0, 1]) {
      expect(
        shouldShowUpdateNotice({
          me: user({
            role: "admin",
            policy: { showUpdateNotice: true },
            notices: { install: 0, update },
          }),
        }),
        `signed ${update}`,
      ).toBe(false);
    }
  });

  it("is suppressed entirely when the policy flag is off", () => {
    expect(
      shouldShowUpdateNotice({
        me: user({ policy: { showUpdateNotice: false } }),
      }),
    ).toBe(false);
  });

  it("stays on when the payload carries no flag at all", () => {
    // A control API older than the field sends nothing, and the contract's
    // default is ON — an upgrade must not silently drop the warning.
    expect(shouldShowUpdateNotice({ me: user({ policy: {} }) })).toBe(true);
  });

  it("shows nothing before the profile has loaded", () => {
    expect(shouldShowUpdateNotice({ me: null })).toBe(false);
  });
});

describe("updateNoticeAcksOf", () => {
  it("reads the count the API sends", () => {
    expect(updateNoticeAcksOf(user({ notices: { install: 3, update: 2 } }))).toBe(2);
  });

  it("reads a missing count as nobody having signed", () => {
    // An older control API sends no counters. Zero means "show it", which is
    // the safe direction: the alternative silently drops a warning.
    expect(updateNoticeAcksOf({ notices: undefined })).toBe(0);
    expect(updateNoticeAcksOf(null)).toBe(0);
  });

  it("refuses to be talked into a negative or fractional count", () => {
    expect(updateNoticeAcksOf({ notices: { install: 0, update: -4 } })).toBe(0);
    expect(updateNoticeAcksOf({ notices: { install: 0, update: 1.9 } })).toBe(1);
  });
});

describe("signatureIsEnough", () => {
  it("ignores a stray tap", () => {
    // The pad sits in a scrollable dialog on a phone; a finger brushing it
    // while scrolling must not arm the button that hands over a key.
    expect(signatureIsEnough([[{ x: 10, y: 10 }]])).toBe(false);
    expect(
      signatureIsEnough([[{ x: 10, y: 10 }, { x: 12, y: 11 }]]),
    ).toBe(false);
  });

  it("accepts a real scribble", () => {
    expect(signatureIsEnough([line(SIGNATURE_MIN_LENGTH + 1)])).toBe(true);
  });

  it("adds the strokes up rather than judging them one at a time", () => {
    // Nobody signs in one stroke. Three short ones that together clear the
    // threshold are a signature; requiring one long one would reject most.
    const third = SIGNATURE_MIN_LENGTH / 3 + 1;
    expect(signatureIsEnough([line(third), line(third), line(third)])).toBe(true);
  });

  it("measures travel, not displacement", () => {
    // Scribbling back and forth over the same 20px counts every pass, which is
    // what makes a small signature in the corner of the pad acceptable.
    const backAndForth: SignatureStroke = [];
    for (let i = 0; i < 10; i += 1) {
      backAndForth.push({ x: 0, y: 0 }, { x: 20, y: 0 });
    }
    expect(signatureLength([backAndForth])).toBeGreaterThan(
      SIGNATURE_MIN_LENGTH,
    );
  });

  it("survives an empty pad and an empty stroke", () => {
    expect(signatureIsEnough([])).toBe(false);
    expect(signatureLength([[]])).toBe(0);
  });
});
