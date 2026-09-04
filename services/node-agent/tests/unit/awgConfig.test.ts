import { describe, expect, it } from "vitest";

import { isAwgToggleEnabled, parseAwgParams } from "@/helpers/awgConfig";

// `awg`'s own parse_bool (amneziawg-tools src/config.c) accepts `on`/`off`
// case-insensitively AND a decimal number, where the value is `ret != 0`. So
// `DisableCookies = 0` means OFF on the wire, and anything that reads it as ON
// disagrees with the daemon about what the node is actually doing.
describe("isAwgToggleEnabled", () => {
  it("reads the word form the way awg does", () => {
    expect(isAwgToggleEnabled("on")).toBe(true);
    expect(isAwgToggleEnabled("On")).toBe(true);
    expect(isAwgToggleEnabled(" on ")).toBe(true);
    expect(isAwgToggleEnabled("off")).toBe(false);
    expect(isAwgToggleEnabled("OFF")).toBe(false);
  });

  it("reads the numeric form the way awg does", () => {
    // This is the bug: "0" is a perfectly legal way to write "off", and
    // treating it as enabled reports a node as running a feature it is not.
    expect(isAwgToggleEnabled("0")).toBe(false);
    expect(isAwgToggleEnabled("1")).toBe(true);
    expect(isAwgToggleEnabled("2")).toBe(true);
    expect(isAwgToggleEnabled("00")).toBe(false);
  });

  it("treats an absent or unparseable value as disabled", () => {
    // awg exits on a value that is neither on/off nor numeric. We are only
    // reading a config, so the safe reading is "not enabled" rather than a
    // crash - but it must never be "enabled".
    expect(isAwgToggleEnabled("")).toBe(false);
    expect(isAwgToggleEnabled("   ")).toBe(false);
    expect(isAwgToggleEnabled("yes")).toBe(false);
    expect(isAwgToggleEnabled("true")).toBe(false);
  });
});

describe("parseAwgParams", () => {
  it("does not carry a disabled toggle into a client config", () => {
    const params = parseAwgParams(
      ["[Interface]", "RandomTrailers = on", "DisableCookies = 0"].join("\n"),
    );

    expect(params.RandomTrailers).toBe("on");
    expect(params.DisableCookies).toBe("");
  });
});
