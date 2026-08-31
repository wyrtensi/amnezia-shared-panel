import { describe, it, expect } from "vitest";
import { flagOf, positionals, csvList, parseNodeSpec } from "./args.js";

describe("flagOf", () => {
  it("reads --name=value and preserves '=' in the value", () => {
    expect(flagOf(["--a=1", "--b=x=y"], "b")).toBe("x=y");
  });
  it("is undefined for a missing flag", () => {
    expect(flagOf(["--a=1"], "z")).toBeUndefined();
  });
});

describe("positionals", () => {
  it("keeps only non-flag args", () => {
    expect(positionals(["x", "--a=1", "y"])).toEqual(["x", "y"]);
  });
});

describe("csvList", () => {
  it("trims and drops empties", () => {
    expect(csvList(" a , b ,,c ")).toEqual(["a", "b", "c"]);
    expect(csvList("")).toEqual([]);
  });
});

describe("parseNodeSpec", () => {
  it("maps all -> null (every node)", () => {
    expect(parseNodeSpec("all")).toBeNull();
  });
  it("maps none -> [] (no node)", () => {
    expect(parseNodeSpec("none")).toEqual([]);
  });
  it("maps a csv to a trimmed list", () => {
    expect(parseNodeSpec("a, b ,c")).toEqual(["a", "b", "c"]);
  });
});
