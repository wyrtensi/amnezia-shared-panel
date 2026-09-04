import { afterEach, describe, expect, it } from "vitest";
import { nonNegativeIntegerEnv, positiveIntegerEnv } from "./envInt.js";

// This file exists because `main.ts` (where these knobs used to live inline)
// opens a database connection and reads required env vars at import time, so
// it cannot be imported directly in a test. The parsing was split out into
// `envInt.ts` for exactly that reason — see that file's header comment.
const VAR = "TEST_ENV_INT_AT_LEAST";

afterEach(() => {
  delete process.env[VAR];
});

describe("nonNegativeIntegerEnv", () => {
  it("uses the fallback when unset", () => {
    expect(nonNegativeIntegerEnv(VAR, 10)).toBe(10);
  });

  it("uses the fallback for a whitespace-only value instead of parsing it as 0", () => {
    // `Number(" ")` is `0`, a legal "no cap" value for this variant. Without
    // trimming first, `ACCESS_SYNC_MAX_DISABLES="   "` would silently disable
    // the blast-radius cap instead of falling back to the documented default.
    process.env[VAR] = "   ";
    expect(nonNegativeIntegerEnv(VAR, 10)).toBe(10);
  });

  it("accepts an explicit zero", () => {
    process.env[VAR] = "0";
    expect(nonNegativeIntegerEnv(VAR, 10)).toBe(0);
  });

  it("rejects a negative value", () => {
    process.env[VAR] = "-1";
    expect(() => nonNegativeIntegerEnv(VAR, 10)).toThrow(
      `${VAR} must be a non-negative integer`,
    );
  });
});

describe("positiveIntegerEnv", () => {
  it("uses the fallback for a whitespace-only value", () => {
    process.env[VAR] = "  \t ";
    expect(positiveIntegerEnv(VAR, 5)).toBe(5);
  });

  it("rejects an explicit zero", () => {
    process.env[VAR] = "0";
    expect(() => positiveIntegerEnv(VAR, 5)).toThrow(
      `${VAR} must be a positive integer`,
    );
  });

  it("accepts a positive integer", () => {
    process.env[VAR] = "42";
    expect(positiveIntegerEnv(VAR, 5)).toBe(42);
  });
});
