import { describe, expect, it } from "vitest";
import {
  configFilename,
  contentDispositionAttachment,
} from "./configFilename.js";

describe("config file names", () => {
  it("names a download after the connection it creates", () => {
    expect(configFilename("Frankfurt Main laptop #3", "vpn")).toBe(
      "Frankfurt Main laptop #3.vpn",
    );
    expect(configFilename("Frankfurt Main laptop #3", "conf")).toBe(
      "Frankfurt Main laptop #3.conf",
    );
  });

  it("keeps non-Latin names, which is the point of the header pair", () => {
    const name = "Франкфурт #3";
    expect(configFilename(name, "vpn")).toBe(`${name}.vpn`);
  });

  it("drops what a file system would reject and collapses the gap", () => {
    expect(configFilename('Berlin / Anna: "work" <laptop>', "vpn")).toBe(
      "Berlin Anna work laptop.vpn",
    );
    expect(configFilename("a\tb", "vpn")).toBe("a b.vpn");
  });

  it("never produces a hidden file or a name that loses its extension", () => {
    // A leading dot hides the file on Unix; Windows silently eats a trailing
    // dot or space, which would leave the download with no extension at all.
    expect(configFilename("...hidden", "vpn")).toBe("hidden.vpn");
    expect(configFilename("trailing. ", "vpn")).toBe("trailing.vpn");
  });

  it("falls back rather than emitting a bare extension", () => {
    expect(configFilename(null, "conf")).toBe("amnezia-key.conf");
    expect(configFilename("///", "conf")).toBe("amnezia-key.conf");
  });

  it("caps the stem without touching the extension", () => {
    const long = "x".repeat(200);
    const built = configFilename(long, "vpn");
    expect(built.endsWith(".vpn")).toBe(true);
    expect(built).toBe(`${"x".repeat(60)}.vpn`);
  });

  it("sends one form only when the name is already ASCII", () => {
    expect(contentDispositionAttachment("Frankfurt.vpn")).toBe(
      'attachment; filename="Frankfurt.vpn"',
    );
  });

  it("sends an ASCII fallback and the real name when they differ", () => {
    const header = contentDispositionAttachment("Frankfurt Main laptop #3.vpn");
    expect(header).toContain('filename="Frankfurt-Main-laptop-3.vpn"');
    expect(header).toContain(
      "filename*=UTF-8''Frankfurt%20Main%20laptop%20%233.vpn",
    );
  });

  it("keeps a usable ASCII name when the fold leaves nothing", () => {
    // Cyrillic folds to the empty string, and `filename="…"` is the half an
    // older client reads: without the fallback stem it would read as no name.
    const header = contentDispositionAttachment("Франкфурт.vpn");
    expect(header).toContain('filename="amnezia-key.vpn"');
    expect(header).toContain(
      "filename*=UTF-8''%D0%A4%D1%80%D0%B0%D0%BD%D0%BA%D1%84%D1%83%D1%80%D1%82.vpn",
    );
  });

  it("cannot be talked into closing the quoted string early", () => {
    const header = contentDispositionAttachment('a"; attachment; x=".vpn');
    expect(header.match(/"/g)).toHaveLength(2);
    expect(header).not.toContain('x="');
  });

  it("percent-encodes what RFC 5987 excludes from an ext-value", () => {
    expect(contentDispositionAttachment("a'b(c)!*.vpn")).toContain(
      "filename*=UTF-8''a%27b%28c%29%21%2A.vpn",
    );
  });
});
