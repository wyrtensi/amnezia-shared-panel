import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { awgGeneratorPresets, type AwgGeneratorPreset } from "@amnezia/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { messages } from "@/lib/i18n/messages";
import { AwgKeySettingsSummary, AwgNewKeySettings, inheritedForNewKey } from "./awg-client-settings";
import { DeviceRulesEditor, deviceRuleRows, withDeviceRule } from "./awg-device-rules-editor";
import { MtuField } from "./awg-mtu-field";
import { GeneratorEditor } from "./node-generator-settings";

const ru = messages.ru;
const preset = (id: AwgGeneratorPreset) =>
  structuredClone(awgGeneratorPresets().find((entry) => entry.id === id)!.settings);
const render = (node: React.ReactElement) => renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
const noop = () => undefined;

describe("client MTU field", () => {
  it("shows the inherited MTU and its source, and an own value in its own input", () => {
    const inherited = render(
      <MtuField id="mtu" value={null} inherited={{ mtu: 1380, source: "node" }} onChange={noop} />,
    );
    expect(inherited).toContain("Сейчас 1380 (от сервера)");
    expect(inherited).not.toContain('type="number"');

    const own = render(<MtuField id="mtu" value={1300} inherited={{ mtu: 1380, source: "node" }} onChange={noop} />);
    expect(own).toContain('value="1300"');
    expect(own).toContain(ru["awgSettings.mtuOwnHint"]);
  });

  it("puts the MTU in every profile editor, also while the profile inherits", () => {
    const html = render(
      <GeneratorEditor
        value={null} mtu={null} inheritLabel="inherit" inheritedMtu={{ mtu: 1400, source: "address" }}
        pending={false} onSave={() => Promise.resolve(true)}
      />,
    );
    expect(html).toContain(ru["generator.mtu"]);
    expect(html).toContain("Сейчас 1400 (от адреса)");
  });
});

describe("device type rules", () => {
  const rules = {
    windows: { awgGenerator: null, awgMtu: 1360 },
    ios: { awgGenerator: preset("stun"), awgMtu: 1340 },
  };

  it("lists one row per device type with a rule and offers the free types", () => {
    expect(deviceRuleRows(rules)).toEqual({
      set: ["ios", "windows"],
      free: ["android", "macos", "linux", "other"],
    });
    const html = render(
      <DeviceRulesEditor
        rules={rules}
        inherited={{ awgGenerator: null, mtu: 1280, mtuFrom: "default" }}
        pending={false}
        onSave={() => Promise.resolve(true)}
      />,
    );
    expect(html).toContain(ru["device.ios"]);
    expect(html).toContain("Профиль: STUN-запрос · MTU 1340");
    expect(html).toContain("Профиль: как у адреса · MTU 1360");
    expect(html).toContain(ru["awgRules.add"]);
    expect(html).toContain(ru["awgSettings.notProbed"]);
  });

  it("adds, replaces and removes one rule, and stores none when the last goes", () => {
    const added = withDeviceRule(rules, "android", { awgGenerator: null, awgMtu: 1300 });
    expect(Object.keys(added ?? {})).toEqual(["windows", "ios", "android"]);
    expect(withDeviceRule(rules, "ios", null)).toEqual({ windows: rules.windows });
    expect(withDeviceRule({ ios: rules.ios }, "ios", null)).toBeNull();
  });
});

describe("key settings", () => {
  const config = {
    awgGenerator: preset("stun"), profileFrom: "key" as const, mtu: 1360, mtuFrom: "user" as const,
  };

  it("marks a key with its own or its owner's settings as not checked by the probe", () => {
    const manual = render(<AwgKeySettingsSummary config={{ ...config, probeChecked: false }} />);
    expect(manual).toContain("Конфиг: STUN-запрос (от ключа) · MTU 1360 (от пользователя)");
    expect(manual).toContain(ru["awgSettings.manual"]);
    const checked = render(<AwgKeySettingsSummary config={{ ...config, probeChecked: true }} />);
    expect(checked).not.toContain(ru["awgSettings.manual"]);
  });

  it("names what a new key inherits, the way the API resolves it", () => {
    expect(inheritedForNewKey({
      user: { awgGenerator: null, awgMtu: 1360 },
      deviceType: "ios",
      endpoint: { awgDeviceRules: { ios: { awgGenerator: preset("stun"), awgMtu: 1340 } } },
      node: { awgMtu: 1400 },
    })).toMatchObject({ profileFrom: "device", mtu: 1360, mtuFrom: "user" });
    expect(inheritedForNewKey({
      user: null, deviceType: "unspecified",
      endpoint: { awgDeviceRules: { ios: { awgGenerator: preset("stun"), awgMtu: 1340 } } },
      node: { awgMtu: 1400 },
    })).toMatchObject({ profileFrom: null, mtu: 1400, mtuFrom: "node" });
  });

  it("keeps a new key's settings collapsed until they are set", () => {
    const closed = render(
      <AwgNewKeySettings
        idPrefix="new" value={{ awgGenerator: null, awgMtu: null }} onChange={noop} inherited={null} pending={false}
      />,
    );
    expect(closed).toContain(ru["awgSettings.keyTitle"]);
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain(ru["generator.mtu"]);
    const set = render(
      <AwgNewKeySettings
        idPrefix="new" value={{ awgGenerator: null, awgMtu: 1300 }} onChange={noop} inherited={null} pending={false}
      />,
    );
    expect(set).toContain('aria-expanded="true"');
    expect(set).toContain(ru["awgSettings.manual"]);
    expect(set).toContain(ru["generator.mtu"]);
  });
});
