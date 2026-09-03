import { describe, expect, it } from "vitest";

import {
  CLI_CONFIG_FORMATS,
  configFrameName,
  configOutputName,
  configRequestPath,
  confirmedFromArgs,
  formatQrParams,
} from "./configPath.js";

describe("configRequestPath", () => {
  it("builds the owner path for each format", () => {
    expect(configRequestPath("key-1", "vpn", false)).toBe(
      "/api/keys/key-1/config?format=vpn",
    );
    expect(configRequestPath("key-1", "qr", false)).toBe(
      "/api/keys/key-1/config?format=qr",
    );
    expect(configRequestPath("key-1", "qr-svg", false)).toBe(
      "/api/keys/key-1/config?format=qr-svg",
    );
    expect(configRequestPath("key-1", "qr-frames", false)).toBe(
      "/api/keys/key-1/config?format=qr-frames",
    );
  });

  it("adds the admin confirmation only when asked", () => {
    expect(configRequestPath("key-1", "conf", true)).toBe(
      "/api/keys/key-1/config?format=conf&adminConfirmed=true",
    );
  });

  it("escapes a key id that is not URL-safe", () => {
    expect(configRequestPath("a b/c", "vpn", false)).toBe(
      "/api/keys/a%20b%2Fc/config?format=vpn",
    );
  });
});

describe("confirmedFromArgs", () => {
  it("accepts both spellings of --confirm", () => {
    // `--confirm=<value>` is the shape node-remove teaches, so key-config must
    // not silently treat it as absent. Added by the CLI audit, 2026-09-03.
    for (const spelling of ["--confirm", "--confirm=true", "--confirm=yes"]) {
      expect(confirmedFromArgs([spelling])).toBe(true);
    }
    expect(confirmedFromArgs(["--format=qr"])).toBe(false);
    expect(confirmedFromArgs(["--confirmation"])).toBe(false);
  });
});

describe("formatQrParams", () => {
  it("reports the QR parameters the server chose", () => {
    // The dialog and the docs both say the panel "picks the error-correction
    // level from the payload's measured symbol size", and nothing shows which
    // level a given key landed on — the single most useful diagnostic here.
    expect(
      formatQrParams(
        new Headers({
          "x-qr-ecc": "L",
          "x-qr-modules": "113",
          "x-qr-scale": "8",
        }),
      ),
    ).toBe("ecc=L modules=113 scale=8");
  });

  it("says nothing about parameters when the server did not send them", () => {
    // The live control-api does not attach these headers yet, so this is the
    // path that actually runs today: silence, never a line of "undefined".
    expect(formatQrParams(new Headers())).toBeNull();
  });

  it("prints only the parameters that arrived", () => {
    expect(formatQrParams(new Headers({ "x-qr-ecc": "Q" }))).toBe("ecc=Q");
  });
});

describe("configOutputName", () => {
  it("names the file after the format's real container", () => {
    expect(configOutputName("key-1", "vpn")).toBe("key-1.vpn.txt");
    expect(configOutputName("key-1", "conf")).toBe("key-1.conf");
    expect(configOutputName("key-1", "qr")).toBe("key-1.png");
    expect(configOutputName("key-1", "qr-svg")).toBe("key-1.svg");
  });
});

describe("configFrameName", () => {
  it("numbers the AmneziaVPN frames from one", () => {
    expect(configFrameName("key-1", 0)).toBe("key-1.frame-1.svg");
    expect(configFrameName("key-1", 1)).toBe("key-1.frame-2.svg");
    expect(configFrameName("/tmp/out", 0)).toBe("/tmp/out.frame-1.svg");
  });
});

describe("CLI_CONFIG_FORMATS", () => {
  it("matches the API's ConfigFormat union", () => {
    expect([...CLI_CONFIG_FORMATS]).toEqual([
      "vpn",
      "conf",
      "qr",
      "qr-svg",
      "qr-frames",
    ]);
  });
});
