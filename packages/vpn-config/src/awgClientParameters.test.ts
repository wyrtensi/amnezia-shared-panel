import { AWG_CLIENT_PARAMETER_NAMES } from "@amnezia/contracts";
import { describe, expect, it } from "vitest";

import { readAwg31ClientParameters } from "./awgClientInterface.js";
import { encodeVpnPayload } from "./codec.js";
import { buildArtifact, buildLink, lastConfigOf } from "./fixtures.js";

const withLines = (extra: string[]) => ({
  conf: (text: string) => text.replace("[Peer]", `${extra.join("\n")}\n\n[Peer]`),
});

const byName = (link: string) =>
  new Map(readAwg31ClientParameters(link)?.map((entry) => [entry.name, entry]));

describe("readAwg31ClientParameters", () => {
  it("reads every whitelisted parameter in order with server scope for S and H", () => {
    const link = buildLink(withLines([
      "ContentPaddingAddition = 12",
      "RekeyAfterTime = 120",
      "MTU = 1280",
    ]));
    const result = readAwg31ClientParameters(link);
    expect(result?.map((entry) => entry.name)).toEqual([...AWG_CLIENT_PARAMETER_NAMES]);
    const params = byName(link);
    expect(params.get("Jc")).toEqual({ name: "Jc", value: "8", scope: "client" });
    expect(params.get("S3")).toEqual({ name: "S3", value: "20", scope: "server" });
    expect(params.get("H1")).toEqual({ name: "H1", value: "1000-2000", scope: "server" });
    expect(params.get("I1")?.value).toBe("<b 0xc70000000108aaaaaaaaaaaaaaaa><r 16>");
    expect(params.get("ContentPaddingAddition")?.value).toBe("12");
    expect(params.get("MTU")?.value).toBe("1280");
    const scopes = new Set(result?.filter((e) => e.scope === "server").map((e) => e.name));
    expect(scopes).toEqual(new Set(["S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4"]));
  });

  it("returns null value for a parameter the config does not carry", () => {
    const params = byName(buildLink());
    expect(params.get("I2")).toEqual({ name: "I2", value: null, scope: "client" });
    expect(params.get("RekeyTimeout")?.value).toBeNull();
    expect(params.get("MTU")?.value).toBeNull();
  });

  it("never returns a private, preshared or header protection key", () => {
    const link = buildLink(withLines(["MTU = 1280"]));
    const json = JSON.stringify(readAwg31ClientParameters(link));
    for (const secret of [
      "synthetic-client-private-key",
      "synthetic-psk",
      "synthetic-header-protection",
    ]) {
      expect(json).not.toContain(secret);
    }
  });

  it("returns null for a 2.0 artifact", () => {
    expect(readAwg31ClientParameters(buildLink({ protocolVersion: null }))).toBeNull();
  });

  it("reads case-insensitive Interface fields just as the writer does", () => {
    const link = buildLink({ conf: (text) => text
      .replace("[Interface]", "[interface]")
      .replace("Jc = 8", "jC = 8")
      .replace("S3 = 20", "s3 = 20")
      .replace("[Peer]", "mTu = 1320\ncontentpaddingaddition = 11\n[Peer]") });
    const params = byName(link);
    expect(params.get("Jc")?.value).toBe("8");
    expect(params.get("S3")?.value).toBe("20");
    expect(params.get("MTU")?.value).toBe("1320");
    expect(params.get("ContentPaddingAddition")?.value).toBe("11");
  });

  it("reads the actual Interface from an object artifact without overlay prerequisites", () => {
    const payload = buildArtifact();
    const awg = payload.containers![0]!.awg!;
    awg.last_config = lastConfigOf(payload);
    awg.Jc = "99";
    const params = byName(encodeVpnPayload(payload));
    expect(params.get("Jc")?.value).toBe("8");
  });

  it("rejects ambiguous duplicate fields regardless of case", () => {
    expect(readAwg31ClientParameters(buildLink(withLines(["MTU = 1280", "mtu = 1320"])))).toBeNull();
  });
});
