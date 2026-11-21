import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  AWG_GENERATOR_I_MODES,
  AWG_GENERATOR_PRESETS,
  awgGeneratorPresets,
  type AwgGeneratorPreset,
} from "@amnezia/contracts";
import { messages } from "@/lib/i18n/messages";
import { editGeneratorDraft, GeneratorEditor, keyRandomizationState } from "./node-generator-settings";

const preset = (id: AwgGeneratorPreset) =>
  structuredClone(awgGeneratorPresets().find((entry) => entry.id === id)!.settings);
const savedBeforeSwitch = (id: AwgGeneratorPreset) => {
  const settings = preset(id);
  delete settings.randomizeKeys;
  return settings;
};

describe("key randomization switch", () => {
  it("is on for a preset, off and locked for custom, hidden for issued and inherit", () => {
    expect(keyRandomizationState(preset("dns_query"))).toEqual({ visible: true, checked: true, disabled: false });
    expect(keyRandomizationState(preset("custom"))).toEqual({ visible: true, checked: false, disabled: true });
    expect(keyRandomizationState(preset("issued")).visible).toBe(false);
    expect(keyRandomizationState(null).visible).toBe(false);
    expect(keyRandomizationState({ ...preset("stun"), randomizeKeys: false }).checked).toBe(false);
  });

  it("shows settings saved before the switch as they behave", () => {
    // Fixed presets gave every key the same values; ranged ones drew per key.
    expect(keyRandomizationState(savedBeforeSwitch("dns_response")).checked).toBe(false);
    expect(keyRandomizationState(savedBeforeSwitch("dns_query")).checked).toBe(true);
  });

  it("keeps the preset and the switch when only MTU changes", () => {
    const next = editGeneratorDraft(preset("dns_query_stun"), { mtu: 1340 });
    expect(next).toMatchObject({ preset: "dns_query_stun", randomizeKeys: true, mtu: 1340 });
  });

  it("turns a preset into custom with randomization off when Jc changes", () => {
    const next = editGeneratorDraft(preset("dns_query"), { jcMin: 5, jcMax: 6 });
    expect(next).toMatchObject({ preset: "custom", randomizeKeys: false, jcMin: 5, jcMax: 6 });
  });

  it("keeps the randomized preset and its switch when a range changes", () => {
    const next = editGeneratorDraft(preset("randomized"), { jcMin: 5, jcMax: 8 });
    expect(next).toMatchObject({ preset: "randomized", randomizeKeys: true });
  });

  it("switches randomization without changing the preset", () => {
    const next = editGeneratorDraft(preset("dns_response"), { randomizeKeys: false });
    expect(next).toMatchObject({ preset: "dns_response", randomizeKeys: false });
  });

  it("renders the switch for a preset and not for issued", () => {
    const html = (value: ReturnType<typeof preset>) =>
      renderToStaticMarkup(<GeneratorEditor value={value} inherited={false} pending={false} onSave={() => Promise.resolve(true)} />);
    expect(html(preset("stun_dns_response"))).toContain(messages.ru["generator.randomizeKeys"]);
    expect(html(preset("issued"))).not.toContain(messages.ru["generator.randomizeKeys"]);
  });

  it("labels every preset and signature mode in both languages", () => {
    for (const id of [...AWG_GENERATOR_PRESETS, ...AWG_GENERATOR_I_MODES]) {
      const key = `generator.${id}` as keyof typeof messages.ru;
      expect(messages.ru[key], id).toBeTruthy();
      expect(messages.en[key], id).toBeTruthy();
    }
  });
});
