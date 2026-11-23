import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { awgGeneratorPresets, type AwgGeneratorPreset } from "@amnezia/contracts";
import { TooltipProvider } from "@/components/ui/tooltip";
import { messages } from "@/lib/i18n/messages";
import {
  AwgKeySettingsSummary,
  AwgNewKeySettings,
  AwgUserSettingsPanel,
  clientSettingsValid,
  deviceRulesChange,
  inheritedForNewKey,
  userRulesInherited,
  UserKeysInEffect,
} from "./awg-client-settings";
import { addressRulesInherited, DeviceRulesEditor, deviceRuleRows, withDeviceRule } from "./awg-device-rules-editor";
import { inheritedMtuWith, MtuField } from "./awg-mtu-field";
import { GeneratorEditor, initialGeneratorDraft, profileToSave } from "./node-generator-settings";

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
        inherited={addressRulesInherited({ awgGenerator: null, mtu: 1280, mtuFrom: "default" }, () => "Без профиля")}
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
    // The owner's rule for the device type sits between the key and the owner.
    expect(inheritedForNewKey({
      user: { awgGenerator: null, awgMtu: 1360, awgDeviceRules: { ios: { awgGenerator: preset("stun"), awgMtu: 1320 } } },
      deviceType: "ios",
      endpoint: { awgDeviceRules: { ios: { awgGenerator: preset("dns_query"), awgMtu: 1340 } } },
      node: { awgMtu: 1400 },
    })).toMatchObject({ profileFrom: "userDevice", mtu: 1320, mtuFrom: "userDevice" });
    expect(inheritedForNewKey({
      user: { awgGenerator: null, awgMtu: 1360, awgDeviceRules: { ios: { awgGenerator: preset("stun"), awgMtu: 1320 } } },
      deviceType: "android",
      endpoint: null,
      node: { awgMtu: 1400 },
    })).toMatchObject({ profileFrom: null, mtu: 1360, mtuFrom: "user" });
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

describe("review fixes", () => {
  it("shows the MTU of the level's own profile as what inherit falls back to", () => {
    const html = render(
      <GeneratorEditor
        value={{ ...preset("stun"), mtu: 1400 }} mtu={null} inheritLabel="inherit"
        inheritedMtu={{ mtu: 1280, source: "default", profile: null }}
        pending={false} onSave={() => Promise.resolve(true)}
      />,
    );
    expect(html).toContain("Сейчас 1400 (из профиля)");
    expect(inheritedMtuWith(null, { mtu: 1380, source: "profile", profile: { ...preset("stun"), mtu: 1380 } }))
      .toMatchObject({ mtu: 1380, source: "profile" });
    expect(inheritedMtuWith({ ...preset("stun"), mtu: 1300 }, { mtu: 1380, source: "profile", profile: { ...preset("stun"), mtu: 1380 } }))
      .toMatchObject({ mtu: 1300, source: "profile" });
    expect(inheritedMtuWith({ ...preset("stun"), mtu: 1300 }, { mtu: 1360, source: "node" }))
      .toMatchObject({ mtu: 1360, source: "node" });
  });

  it("sends a profile only opened by the editor back exactly as stored", () => {
    const legacy = { ...preset("randomized"), iMode: "dns_query" as const };
    expect(profileToSave(legacy, initialGeneratorDraft(legacy))).toBe(legacy);
    const edited = { ...initialGeneratorDraft(legacy)!, jcMax: 9 };
    expect(profileToSave(legacy, edited)).toBe(edited);
    expect(profileToSave(null, null)).toBeNull();
  });

  it("refuses to issue a key with an empty or out-of-range own MTU", () => {
    expect(clientSettingsValid({ awgGenerator: null, awgMtu: null })).toBe(true);
    expect(clientSettingsValid({ awgGenerator: preset("stun"), awgMtu: 1340 })).toBe(true);
    expect(clientSettingsValid({ awgGenerator: null, awgMtu: Number.NaN })).toBe(false);
    expect(clientSettingsValid({ awgGenerator: null, awgMtu: 1500 })).toBe(false);
  });
});

describe("user settings dialog", () => {
  const key = (overrides: Record<string, unknown>) => ({
    id: "00000000-0000-4000-8000-000000000001",
    deviceLabel: "Phone",
    deviceType: "ios",
    state: "active",
    endpointName: "Edge-1",
    config: {
      awgGenerator: preset("stun"), profileFrom: "userDevice" as const,
      mtu: 1320, mtuFrom: "userDevice" as const, probeChecked: false,
    },
    ...overrides,
  });

  it("labels the userDevice source in ru and en", () => {
    expect(messages.ru["awgSettings.from.userDevice"]).toBe("от правила пользователя для устройства");
    expect(messages.en["awgSettings.from.userDevice"]).toBe("from the user's device rule");
  });

  it("the user dialog lists keys with profile, MTU and source", () => {
    const keys = [
      key({}),
      key({
        id: "00000000-0000-4000-8000-000000000002", deviceLabel: "", deviceType: "windows",
        config: { awgGenerator: null, profileFrom: null, mtu: 1400, mtuFrom: "node", probeChecked: true },
      }),
      // Not in effect: revoked, and an AWG 2.0 key without a client profile.
      key({ id: "00000000-0000-4000-8000-000000000003", deviceLabel: "Old", state: "revoked" }),
      key({ id: "00000000-0000-4000-8000-000000000004", deviceLabel: "Legacy", config: null }),
    ];
    const html = render(<UserKeysInEffect keys={keys} onShowParameters={noop} />);
    expect(html).toContain("Phone");
    expect(html).toContain(ru["device.ios"]);
    expect(html).toContain(ru["generator.stun"]);
    expect(html).toContain(ru["awgSettings.from.userDevice"]);
    expect(html).toContain("MTU 1320");
    expect(html).toContain(ru["device.windows"]);
    expect(html).toContain(ru["awgSettings.noProfile"]);
    expect(html).toContain("MTU 1400");
    expect(html).toContain(ru["awgSettings.from.node"]);
    expect(html).not.toContain("Old");
    expect(html).not.toContain("Legacy");
    expect(html.split(ru["clientParams.open"]).length - 1).toBe(2);
    expect(render(<UserKeysInEffect keys={[]} onShowParameters={noop} />)).toContain(ru["awgUser.noKeys"]);
  });

  it("the user dialog saves device rules", () => {
    const rules = { android: { awgGenerator: null, awgMtu: 1300 } };
    expect(deviceRulesChange(rules)).toEqual({ awgDeviceRules: rules });
    expect(deviceRulesChange(null)).toEqual({ awgDeviceRules: null });

    const user = { awgGenerator: preset("dns_query"), awgMtu: null, awgDeviceRules: rules };
    expect(userRulesInherited(user, (settings) => settings?.preset ?? "none")).toEqual({
      profileLabel: "dns_query", source: "user", mtu: { mtu: null, source: "keys" },
    });
    const html = render(
      <AwgUserSettingsPanel
        initialTab="devices" user={user} keys={[]} pending={false}
        onSave={() => Promise.resolve(true)} onShowParameters={noop}
      />,
    );
    expect(html).toContain(ru["awgRules.title"]);
    expect(html).toContain(ru["awgRules.userHint"]);
    expect(html).toContain(ru["device.android"]);
    expect(html).toContain(`Профиль: ${ru["awgRules.profileFromUser"]} · MTU 1300`);
    expect(html).toContain(ru["awgUser.tab.profile"]);
    expect(html).toContain(ru["awgUser.tab.keys"]);
  });

  it("disables the settings tabs and key parameters while a save is pending", () => {
    const user = { awgGenerator: null, awgMtu: null, awgDeviceRules: null };
    const controls = (pending: boolean) => {
      const html = render(
        <AwgUserSettingsPanel
          initialTab="keys" user={user} keys={[key({})]} pending={pending}
          onSave={() => Promise.resolve(true)} onShowParameters={noop}
        />,
      );
      return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).filter((button) =>
        button.includes('role="tab"') || button.endsWith(`${ru["clientParams.open"]}</button>`));
    };
    const pending = controls(true);
    expect(pending).toHaveLength(4);
    expect(pending.every((button) => button.includes(' disabled=""'))).toBe(true);
    const idle = controls(false);
    expect(idle).toHaveLength(4);
    expect(idle.every((button) => !button.includes(' disabled=""'))).toBe(true);
  });
});
