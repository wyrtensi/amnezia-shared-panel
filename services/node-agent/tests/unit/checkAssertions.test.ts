import { describe, expect, it } from "vitest";

import {
  ASSERTION_EVALUATORS,
  countOccurrences,
  evaluateAssertions,
  SUPPORTED_ASSERTION_TYPES,
  UnsupportedAssertionError,
  type ProbeOutcome,
} from "@/services/checks/assertions";

const outcome = (overrides: Partial<ProbeOutcome> = {}): ProbeOutcome => ({
  status: 200,
  finalUrl: "https://example.com/app",
  headers: { "content-type": "text/html; charset=utf-8" },
  body: "<html><body>conversation-container conversation-container</body></html>",
  bodyBytes: 70,
  ...overrides,
});

describe("the assertion registry", () => {
  it("advertises exactly the types it can evaluate", () => {
    // This list is what the agent reports in GET /server and what the panel
    // checks a new check against. A type in one and not the other is how a
    // check silently stops being evaluated.
    expect(SUPPORTED_ASSERTION_TYPES).toEqual(
      Object.keys(ASSERTION_EVALUATORS).sort(),
    );
    expect(SUPPORTED_ASSERTION_TYPES).toEqual([
      "bodyBytesAtLeast",
      "bodyContains",
      "bodyContainsAll",
      "bodyContainsAny",
      "bodyOccurrencesAtLeast",
      "bodyOmits",
      "finalUrlContains",
      "finalUrlOmits",
      "headerContains",
      "statusIn",
    ]);
  });

  it("refuses an unknown type instead of treating it as satisfied", () => {
    // The whole safety of an open set rests on this. A node that predates a
    // rule must say so; a silent pass is a green light that means nothing.
    expect(() =>
      evaluateAssertions(outcome(), [{ type: "bodyMatchesRegex", pattern: ".*" }]),
    ).toThrow(UnsupportedAssertionError);
    expect(() => evaluateAssertions(outcome(), [{}])).toThrow(
      /unsupported assertion type/,
    );
  });

  it("returns the first failure and nothing when they all pass", () => {
    expect(
      evaluateAssertions(outcome(), [
        { type: "statusIn", statuses: [200] },
        { type: "bodyContains", value: "conversation-container" },
      ]),
    ).toBeNull();

    expect(
      evaluateAssertions(outcome(), [
        { type: "statusIn", statuses: [200] },
        { type: "bodyContains", value: "not-here" },
        { type: "bodyContains", value: "also-not-here" },
      ]),
    ).toMatch(/"not-here"/);
  });
});

describe("assertion evaluators", () => {
  it("statusIn names what it got and what it wanted", () => {
    expect(
      evaluateAssertions(outcome({ status: 302 }), [
        { type: "statusIn", statuses: [200, 204] },
      ]),
    ).toBe("status 302 is not one of 200, 204");
  });

  it("bodyContains and bodyOmits are opposites over the same needle", () => {
    const marker = { value: "conversation-container" };
    expect(
      evaluateAssertions(outcome(), [{ type: "bodyContains", ...marker }]),
    ).toBeNull();
    expect(
      evaluateAssertions(outcome(), [{ type: "bodyOmits", ...marker }]),
    ).toMatch(/body contains/);
  });

  it("bodyContainsAll names the missing ones only", () => {
    expect(
      evaluateAssertions(outcome(), [
        {
          type: "bodyContainsAll",
          values: ["conversation-container", "absent-one", "absent-two"],
        },
      ]),
    ).toBe('body does not contain "absent-one", "absent-two"');
  });

  it("bodyContainsAny passes on one hit", () => {
    expect(
      evaluateAssertions(outcome(), [
        { type: "bodyContainsAny", values: ["absent", "conversation-container"] },
      ]),
    ).toBeNull();
  });

  it("counts occurrences, which is the signal `contains` cannot express", () => {
    // Measured on the two Gemini captures: 20 on the working page, 0 on the
    // blocked one. A marker present twice on both is not a separator.
    expect(
      evaluateAssertions(outcome(), [
        {
          type: "bodyOccurrencesAtLeast",
          value: "conversation-container",
          count: 2,
        },
      ]),
    ).toBeNull();
    expect(
      evaluateAssertions(outcome(), [
        {
          type: "bodyOccurrencesAtLeast",
          value: "conversation-container",
          count: 3,
        },
      ]),
    ).toBe('body contains "conversation-container" 2 times, wanted at least 3');
  });

  it("counts non-overlapping occurrences", () => {
    // "aaaa" holds two "aa", not three: an overlapping count would make a
    // threshold mean something different from what an admin counted by hand.
    expect(countOccurrences("aaaa", "aa")).toBe(2);
    expect(countOccurrences("abc", "")).toBe(0);
  });

  it("bodyBytesAtLeast measures what was read, not what was sent", () => {
    expect(
      evaluateAssertions(outcome({ bodyBytes: 1_000 }), [
        { type: "bodyBytesAtLeast", count: 900 },
      ]),
    ).toBeNull();
    expect(
      evaluateAssertions(outcome({ bodyBytes: 800 }), [
        { type: "bodyBytesAtLeast", count: 900 },
      ]),
    ).toBe("body is 800 bytes, wanted at least 900");
  });

  it("finalUrl assertions read the address the request landed on", () => {
    const landed = outcome({
      finalUrl: "https://notebook.google/?location=unsupported",
    });
    expect(
      evaluateAssertions(landed, [
        { type: "finalUrlOmits", value: "location=unsupported" },
      ]),
    ).toMatch(/final URL contains/);
    expect(
      evaluateAssertions(landed, [
        { type: "finalUrlContains", value: "notebook.google" },
      ]),
    ).toBeNull();
  });

  it("headerContains is case-insensitive in the name and says when it is absent", () => {
    expect(
      evaluateAssertions(outcome(), [
        { type: "headerContains", name: "Content-Type", value: "text/html" },
      ]),
    ).toBeNull();
    expect(
      evaluateAssertions(outcome(), [
        { type: "headerContains", name: "x-missing", value: "a" },
      ]),
    ).toBe("header x-missing is absent");
  });

  it("keeps a detail on one line even when the marker carries newlines", () => {
    // The detail is stored in a 300-character column and shown on a card. A
    // multi-line marker must not turn one result into several lines of log.
    const detail = evaluateAssertions(outcome(), [
      { type: "bodyContains", value: "a\nb\tc" },
    ]);
    expect(detail).not.toMatch(/[\r\n\t]/);
  });
});
