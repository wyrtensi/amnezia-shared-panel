import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AWG_CLIENT_PARAMETER_NAMES,
  awgClientParameterScope,
  awgGeneratorPresets,
  type AdminClientParameters,
  type AwgGeneratorPreset,
} from "@amnezia/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { messages } from "@/lib/i18n/messages";
import {
  ClientParametersBody,
  ClientParametersSummary,
  ClientParametersTable,
  clientParametersPath,
  KeyPinActions,
  parameterGroups,
  PinConfirm,
  pinPlan,
} from "./client-parameters-dialog";

const ru = messages.ru;
const render = (node: React.ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const noop = () => undefined;
const preset = (id: AwgGeneratorPreset) =>
  structuredClone(awgGeneratorPresets().find((entry) => entry.id === id)!.settings);

const values: Record<string, string | null> = {
  Jc: "4", Jmin: "10", Jmax: "50",
  S1: "15", S2: "18", S3: "20", S4: "8",
  H1: "100000-100100", H2: "200000-200100", H3: "300000-300100", H4: "400000-400100",
  I1: "<b 0xc0ffee><r 16>", I2: null, I3: null, I4: null, I5: null,
  ContentPaddingAddition: "12",
  RekeyAfterTime: "120", RekeyTimeout: "5", RejectAfterTime: "240", KeepaliveTimeout: "12", MaxHandshakeAttempts: "16",
  MTU: "1360",
};
const params = (overrides: Record<string, string | null> = {}) =>
  AWG_CLIENT_PARAMETER_NAMES.map((name) => ({
    name,
    value: name in overrides ? overrides[name]! : values[name]!,
    scope: awgClientParameterScope(name),
  }));
const settings = (overrides: Partial<AdminClientParameters["settings"]> = {}): AdminClientParameters["settings"] => ({
  profileFrom: "user",
  mtuFrom: "key",
  preset: "stun",
  mtu: 1360,
  deviceType: "ios",
  ownerId: "00000000-0000-4000-8000-0000000000aa",
  ...overrides,
});
const data = (overrides: Partial<AdminClientParameters> = {}): AdminClientParameters => ({
  exported: params(),
  issued: params({ Jc: "3", I1: null, MTU: "1280" }),
  settings: settings(),
  ...overrides,
});

describe("client parameters view", () => {
  it("renders exported values grouped with server scope marked", () => {
    const groups = parameterGroups(data());
    expect(groups.map((group) => group.id)).toEqual(["junk", "server", "signature", "timings", "mtu"]);
    expect(groups.find((group) => group.id === "server")).toMatchObject({ server: true });
    expect(groups.find((group) => group.id === "junk")).toMatchObject({ server: false });
    expect(groups.find((group) => group.id === "server")!.rows.map((row) => row.name))
      .toEqual(["S1", "S2", "S3", "S4", "H1", "H2", "H3", "H4"]);

    const html = render(<ClientParametersTable data={data()} />);
    expect(html).toContain(ru["clientParams.group.junk"]);
    expect(html).toContain(ru["clientParams.group.server"]);
    expect(html).toContain(ru["clientParams.group.signature"]);
    expect(html).toContain(ru["clientParams.group.timings"]);
    expect(html).toContain(ru["clientParams.serverScope"]);
    expect(html).toContain("100000-100100");
    expect(html).toContain("&lt;b 0xc0ffee&gt;&lt;r 16&gt;");
    // Empty I packets read as a dash, and a set one can be copied.
    expect(html).toContain("—");
    expect(html).toContain(`aria-label="${ru["clientParams.copy"].replace("{name}", "I1")}"`);
    expect(html).not.toContain(`aria-label="${ru["clientParams.copy"].replace("{name}", "I2")}"`);
  });

  it("makes the server scope tooltip trigger reachable by keyboard", () => {
    const html = render(<ClientParametersTable data={data()} />);
    expect(html).toMatch(/<div\b[^>]*tabindex="0"[^>]*>\s*<svg[\s\S]*?<\/svg>сервер<\/div>/);
  });

  it("shows the issued value only where it differs", () => {
    const groups = parameterGroups(data());
    const row = (name: string) => groups.flatMap((group) => group.rows).find((entry) => entry.name === name)!;
    expect(row("Jc")).toMatchObject({ value: "4", issued: "3", differs: true });
    expect(row("Jmin")).toMatchObject({ value: "10", differs: false });
    expect(row("I1")).toMatchObject({ differs: true, issued: null });
    expect(row("MTU")).toMatchObject({ value: "1360", issued: "1280", differs: true });

    const html = render(<ClientParametersTable data={data()} />);
    expect(html).toContain(ru["clientParams.issued"].replace("{value}", "3"));
    expect(html).toContain(ru["clientParams.issued"].replace("{value}", "1280"));
    expect(html).toContain(ru["clientParams.issued"].replace("{value}", "—"));
    expect(html).not.toContain(ru["clientParams.issued"].replace("{value}", "10"));
    const same = render(<ClientParametersTable data={data({ issued: params() })} />);
    expect(same).not.toContain(ru["clientParams.issued"].replace("{value}", ""));
  });

  it("names the profile and MTU with their sources", () => {
    const html = render(<ClientParametersSummary settings={settings({ profileFrom: "userDevice" })} />);
    expect(html).toContain(ru["generator.stun"]);
    expect(html).toContain(ru["awgSettings.from.userDevice"]);
    expect(html).toContain("MTU 1360");
    expect(html).toContain(ru["awgSettings.from.key"]);
    const issued = render(<ClientParametersSummary settings={settings({ preset: null, profileFrom: null, mtuFrom: "default", mtu: 1280 })} />);
    expect(issued).toContain(ru["awgSettings.noProfile"]);
    expect(issued).toContain(ru["awgSettings.from.default"]);
  });

  it("asks the right endpoint for a key, a node and an address", () => {
    expect(clientParametersPath({ kind: "key", id: "k1" })).toBe("/api/admin/keys/k1/client-parameters");
    expect(clientParametersPath({ kind: "node", id: "n1", endpointId: null })).toBe("/api/admin/nodes/n1/client-parameters");
    expect(clientParametersPath({ kind: "node", id: "n1", endpointId: "e1" }))
      .toBe("/api/admin/nodes/n1/client-parameters?endpointId=e1");
  });

  it("says what is missing while loading, on errors and without a service key", () => {
    const loading = render(<ClientParametersBody state={{ status: "loading" }} onRetry={noop} />);
    expect(loading).toContain('aria-busy="true"');
    const noSample = render(
      <ClientParametersBody state={{ status: "error", code: "SAMPLE_KEY_NOT_FOUND", message: "x" }} onRetry={noop} />,
    );
    expect(noSample).toContain(ru["clientParams.noSampleKey"]);
    expect(noSample).not.toContain(ru["clientParams.retry"]);
    const failed = render(
      <ClientParametersBody state={{ status: "error", code: "REQUEST_FAILED", message: "boom" }} onRetry={noop} />,
    );
    expect(failed).toContain(ru["clientParams.loadFailed"]);
    expect(failed).toContain("boom");
    expect(failed).toContain(ru["clientParams.retry"]);
  });
});

describe("pinning a key's settings", () => {
  const owner = { awgGenerator: null, awgMtu: null, awgDeviceRules: null };

  it("offers both pins for a typed key and only the user pin for an unspecified one", () => {
    const typed = render(<KeyPinActions settings={settings()} pending={false} onPick={noop} />);
    expect(typed).toContain(ru["awgPin.user"]);
    expect(typed).toContain(ru["awgPin.device"].replace("{device}", ru["device.ios"]));
    const untyped = render(<KeyPinActions settings={settings({ deviceType: "unspecified" })} pending={false} onPick={noop} />);
    expect(untyped).toContain(ru["awgPin.user"]);
    expect(untyped).not.toContain(ru["awgPin.device"].replace("{device}", ""));
    expect(untyped).toContain(ru["awgPin.deviceUnavailable"]);
  });

  it("the pin confirm names what it replaces", () => {
    const user = pinPlan("user", settings(), {
      awgGenerator: preset("dns_query"),
      awgMtu: 1380,
      awgDeviceRules: { windows: { awgGenerator: null, awgMtu: 1300 } },
    });
    expect(user).toEqual({
      target: "user",
      deviceType: "ios",
      writes: { preset: "stun", mtu: 1360 },
      replaces: { preset: "dns_query", mtu: 1380 },
      fromKey: { profile: false, mtu: true },
      keptTypes: ["windows"],
    });
    const html = render(<PinConfirm plan={user} pending={false} onConfirm={noop} onCancel={noop} />);
    expect(html).toContain(ru["awgPin.writes"].replace("{profile}", ru["generator.stun"]).replace("{mtu}", "1360"));
    expect(html).toContain(ru["awgPin.replaces"].replace("{profile}", ru["generator.dns_query"]).replace("{mtu}", "1380"));
    expect(html).toContain(ru["awgPin.fromKeyMtu"]);
    expect(html).toContain(ru["awgPin.keptTypes"].replace("{types}", ru["device.windows"]));

    // The node's own profile pins as "issued"; a target with nothing set says so.
    const device = pinPlan("device", settings({ preset: null, profileFrom: null, mtuFrom: "default", mtu: 1280 }), owner);
    expect(device).toMatchObject({ writes: { preset: "issued", mtu: 1280 }, replaces: null, keptTypes: [] });
    const empty = render(<PinConfirm plan={device} pending={false} onConfirm={noop} onCancel={noop} />);
    expect(empty).toContain(ru["awgPin.confirmDevice"].replace("{device}", ru["device.ios"]));
    expect(empty).toContain(ru["awgPin.replacesNothing"]);
    expect(empty).toContain(ru["generator.issued"]);

    // A device rule that sets only the MTU still names the profile it inherits.
    const partial = pinPlan("device", settings(), {
      ...owner,
      awgDeviceRules: { ios: { awgGenerator: null, awgMtu: 1340 } },
    });
    expect(partial.replaces).toEqual({ preset: null, mtu: 1340 });
    const partialHtml = render(<PinConfirm plan={partial} pending={false} onConfirm={noop} onCancel={noop} />);
    expect(partialHtml).toContain(
      ru["awgPin.replaces"].replace("{profile}", ru["awgSettings.inherits"]).replace("{mtu}", "1340"),
    );
  });
});
