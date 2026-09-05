import { describe, expect, it } from "vitest";

import {
  CLI_CONFIG_FORMATS,
  configFrameName,
  configOutputName,
  configRequestPath,
  confirmedFromArgs,
  filenameFromContentDisposition,
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

describe("filenameFromContentDisposition", () => {
  it("prefers the form that survives a non-Latin connection name", () => {
    const headers = new Headers({
      "content-disposition":
        "attachment; filename=\"amnezia-key.vpn\"; filename*=UTF-8''%D0%A4%D1%80%D0%B0%D0%BD%D0%BA%D1%84%D1%83%D1%80%D1%82.vpn",
    });
    expect(filenameFromContentDisposition(headers)).toBe("Франкфурт.vpn");
  });

  it("falls back to the quoted ASCII name", () => {
    const headers = new Headers({
      "content-disposition": 'attachment; filename="Frankfurt phone.vpn"',
    });
    expect(filenameFromContentDisposition(headers)).toBe("Frankfurt phone.vpn");
  });

  it("writes into the working directory and nowhere else", () => {
    // The header is our own API's, but a name is still a name: a value with a
    // path in it must not decide where the CLI writes.
    const headers = new Headers({
      "content-disposition":
        "attachment; filename=\"x.vpn\"; filename*=UTF-8''..%2F..%2Fetc%2Fpasswd",
    });
    expect(filenameFromContentDisposition(headers)).toBe("passwd");
    expect(
      filenameFromContentDisposition(
        new Headers({ "content-disposition": 'attachment; filename="../.."' }),
      ),
    ).toBeNull();
  });

  it("returns null when there is nothing to use", () => {
    expect(filenameFromContentDisposition(new Headers())).toBeNull();
    expect(
      filenameFromContentDisposition(
        new Headers({ "content-disposition": "attachment" }),
      ),
    ).toBeNull();
    // A truncated percent escape must not throw the download away.
    expect(
      filenameFromContentDisposition(
        new Headers({ "content-disposition": "attachment; filename*=UTF-8''%" }),
      ),
    ).toBeNull();
  });
});

describe("configOutputName", () => {
  it("names the file after the format's real container", () => {
    // `.vpn`, not `.vpn.txt`: the client's file picker offers `*.vpn` and hides
    // a `.txt`, and this is the only file shape that keeps the key's name.
    expect(configOutputName("key-1", "vpn")).toBe("key-1.vpn");
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
