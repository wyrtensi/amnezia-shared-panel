import { describe, expect, it } from "vitest";
import {
  ASSERTION_FLAGS,
  assertionUsageLines,
  describeAssertions,
  parseAssertions,
  parseProbe,
  resultLabel,
} from "./serviceChecks.js";

describe("parseAssertions", () => {
  it("builds one assertion per flag, in the order they were given", () => {
    expect(
      parseAssertions([
        "--status-in=200,204",
        "--omits=account-rejected",
        "--final-url-omits=unsupported-country",
      ]),
    ).toEqual([
      { type: "statusIn", statuses: [200, 204] },
      { type: "bodyOmits", value: "account-rejected" },
      { type: "finalUrlOmits", value: "unsupported-country" },
    ]);
  });

  it("accepts the same flag more than once", () => {
    // Three markers that must all be absent is three assertions, not one flag
    // that overwrites itself - which is what a single-value flag helper would
    // have done, silently.
    expect(parseAssertions(["--omits=a", "--omits=b"])).toEqual([
      { type: "bodyOmits", value: "a" },
      { type: "bodyOmits", value: "b" },
    ]);
  });

  it("parses the count assertion, which needs two values in one flag", () => {
    expect(
      parseAssertions(["--contains-at-least=10:conversation-container"]),
    ).toEqual([
      {
        type: "bodyOccurrencesAtLeast",
        count: 10,
        value: "conversation-container",
      },
    ]);
  });

  it("keeps a colon that belongs to the marker itself", () => {
    // Splitting on the LAST colon would mangle a marker containing one; the
    // separator is the first, and everything after it is the value.
    expect(parseAssertions(["--header-contains=content-type:text/html"])).toEqual(
      [{ type: "headerContains", name: "content-type", value: "text/html" }],
    );
  });

  it("refuses a two-part flag given only one part, and says the shape", () => {
    expect(() => parseAssertions(["--contains-at-least=10"])).toThrow(
      /<count>:<text>/,
    );
    expect(() => parseAssertions(["--header-contains=content-type"])).toThrow(
      /<name>:<text>/,
    );
  });

  it("ignores flags that are not assertions", () => {
    expect(
      parseAssertions(["--url=https://example.com/", "--json", "positional"]),
    ).toEqual([]);
  });

  it("documents every flag it accepts", () => {
    // The usage text is derived from the same table the parser reads, so a new
    // assertion cannot ship undocumented.
    expect(assertionUsageLines()).toHaveLength(ASSERTION_FLAGS.length);
    for (const line of assertionUsageLines()) {
      expect(line.trim().startsWith("--")).toBe(true);
    }
  });
});

describe("parseProbe", () => {
  it("defaults to GET and leaves the timeout to the server", () => {
    expect(parseProbe("https://example.com/", undefined, undefined)).toEqual({
      kind: "http",
      url: "https://example.com/",
      method: "GET",
    });
  });

  it("accepts HEAD in any case", () => {
    expect(parseProbe("https://example.com/", "head", "5000")).toEqual({
      kind: "http",
      url: "https://example.com/",
      method: "HEAD",
      timeoutMs: 5000,
    });
  });

  it("refuses a method the probe does not implement", () => {
    expect(() => parseProbe("https://example.com/", "POST", undefined)).toThrow(
      /GET or HEAD/,
    );
  });

  it("refuses a check with no URL", () => {
    expect(() => parseProbe(undefined, undefined, undefined)).toThrow(/--url/);
  });
});

describe("describeAssertions", () => {
  it("fits a check's rules into one table cell", () => {
    expect(
      describeAssertions([
        { type: "statusIn", statuses: [200] },
        { type: "bodyOccurrencesAtLeast", value: "conversation-container", count: 10 },
        { type: "bodyOmits", value: "account-rejected" },
      ]),
    ).toBe(
      "status in 200; conversation-container x10; bodyOmits account-rejected",
    );
  });

  it("does not crash on a type this build has never heard of", () => {
    // A newer panel can hold a rule an older CLI does not know. Printing it
    // roughly beats printing nothing, and beats throwing over a table row.
    expect(describeAssertions([{ type: "somethingNewer", value: "x" }])).toBe(
      "somethingNewer x",
    );
  });
});

describe("resultLabel", () => {
  it("keeps error distinct from failed", () => {
    // `failed` means the service answered wrong; `error` means the node could
    // not look, so nothing is known. Collapsing them would tell an operator a
    // service is blocked when the node never reached it.
    expect(resultLabel({ status: "error", detail: "fetch failed" })).toBe(
      "error (fetch failed)",
    );
    expect(resultLabel({ status: "ok", detail: null })).toBe("ok");
  });
});
