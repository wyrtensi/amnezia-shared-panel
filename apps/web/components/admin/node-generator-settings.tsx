"use client";

import * as React from "react";
import { toast } from "sonner";
import {
  AWG_GENERATOR_I_MODES,
  AWG_GENERATOR_PRESETS,
  awgClientMtuSchema,
  awgGeneratorPresets,
  awgGeneratorSettingsSchema,
  type AwgDeviceRules,
  type AwgGeneratorSettings,
} from "@amnezia/contracts";
import { inheritedMtuWith, MtuField, type InheritedMtu } from "@/components/admin/awg-mtu-field";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n/provider";

export type GeneratorEndpoint = {
  id: string;
  name: string;
  awgGenerator?: AwgGeneratorSettings | null;
  awgMtu?: number | null;
  awgDeviceRules?: AwgDeviceRules | null;
};

/** The preset's name, or the issued artifact's when nothing sets one. */
export const usePresetLabel = () => {
  const { t } = useT();
  return (settings: AwgGeneratorSettings | null) =>
    settings ? t(`generator.${settings.preset}`) : t("awgSettings.noProfile");
};

/**
 * Apply an edit to the draft. MTU and the key randomization switch keep the
 * preset; any other field makes it Custom with randomization off, except a
 * range edit on the randomized preset, which stays randomized.
 */
export const editGeneratorDraft = (
  current: AwgGeneratorSettings,
  change: Partial<AwgGeneratorSettings>,
): AwgGeneratorSettings => {
  if (Object.keys(change).every((field) => field === "mtu" || field === "randomizeKeys")) {
    return { ...current, ...change };
  }
  if (current.preset === "randomized" && change.iMode === undefined) return { ...current, ...change };
  return { ...current, ...change, preset: "custom", randomizeKeys: false };
};

/**
 * How the key randomization switch shows for a draft: hidden for an inherited
 * or issued profile, off and locked for Custom. Settings saved before the
 * switch read the way they behave: only the plain DNS response gave every key
 * the same config; ranged presets, the random-TTL response and a ranged
 * Custom differed per key. `editShares` marks an old Custom, which any edit
 * turns into one shared set for every key.
 */
export const keyRandomizationState = (
  draft: AwgGeneratorSettings | null,
): { visible: boolean; checked: boolean; disabled: boolean; editShares: boolean } => {
  if (!draft || draft.preset === "issued") {
    return { visible: false, checked: false, disabled: true, editShares: false };
  }
  const legacy = draft.randomizeKeys === undefined;
  if (draft.preset === "custom") {
    return { visible: true, checked: legacy, disabled: true, editShares: legacy };
  }
  return {
    visible: true,
    checked: draft.randomizeKeys ?? draft.preset !== "dns_response",
    disabled: false,
    editShares: false,
  };
};

/** Settings saved with the legacy randomized query open as the mixed mode it stands for. */
export const initialGeneratorDraft = (value: AwgGeneratorSettings | null): AwgGeneratorSettings | null =>
  value && value.preset === "randomized" && value.iMode === "dns_query" ? { ...value, iMode: "mixed" } : value;

/**
 * The profile to save: the stored one when the editor only opened it (an old
 * randomized query opens as the mixed mode), so saving another field, such as
 * the MTU, does not re-seed every key's draw.
 */
export const profileToSave = (
  stored: AwgGeneratorSettings | null,
  draft: AwgGeneratorSettings | null,
): AwgGeneratorSettings | null =>
  JSON.stringify(draft) === JSON.stringify(initialGeneratorDraft(stored)) ? stored : draft;

/**
 * The profile part of the editor, controlled and without a form, so the
 * same fields serve a node, an address, a device rule, a user, a key and the
 * key issue dialogs. The client MTU is a separate field (`MtuField`).
 */
export function GeneratorFields({ draft, onDraftChange, pending, inheritLabel, idPrefix = "generator" }: {
  draft: AwgGeneratorSettings | null;
  onDraftChange: (draft: AwgGeneratorSettings | null) => void;
  pending: boolean;
  /** The "inherit" option, naming what is inherited. */
  inheritLabel: string;
  idPrefix?: string;
}) {
  const { t } = useT();
  const presets = awgGeneratorPresets();
  const update = (change: Partial<AwgGeneratorSettings>) => {
    if (draft) onDraftChange(editGeneratorDraft(draft, change));
  };
  const randomization = keyRandomizationState(draft);
  const timings = draft?.timings;
  return (
    <>
      <div className="grid gap-1.5">
        <Label htmlFor={`${idPrefix}-preset`}>{t("generator.preset")}</Label>
        <Select
          value={draft?.preset ?? "inherit"}
          disabled={pending}
          onValueChange={(next) => {
            const preset = presets.find((entry) => entry.id === next);
            onDraftChange(preset ? structuredClone(preset.settings) : null);
          }}
        >
          <SelectTrigger id={`${idPrefix}-preset`}>
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">{inheritLabel}</SelectItem>
            {AWG_GENERATOR_PRESETS.map((id) => (
              <SelectItem key={id} value={id}>{t(`generator.${id}`)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      {randomization.visible ? (
        <div className="flex items-start justify-between gap-3 text-sm">
          <span className="grid gap-0.5">
            <span className="font-medium">{t("generator.randomizeKeys")}</span>
            <span className="text-xs text-muted-foreground">{t("generator.randomizeKeysHint")}</span>
          </span>
          <Switch
            aria-label={t("generator.randomizeKeys")}
            checked={randomization.checked}
            disabled={randomization.disabled}
            onCheckedChange={(checked) => update({ randomizeKeys: checked })}
          />
        </div>
      ) : null}
      {randomization.editShares ? (
        <p className="text-xs text-warning">{t("generator.randomizeKeysLegacyCustom")}</p>
      ) : null}
      {draft && draft.preset !== "issued" ? (
        <>
          <Range
            label="Jc" min={draft.jcMin} max={draft.jcMax} lower={0} upper={16}
            onChange={(jcMin, jcMax) => update({ jcMin, jcMax })}
          />
          <Range
            label="Jmin" min={draft.jminMin} max={draft.jminMax} lower={1} upper={500}
            onChange={(jminMin, jminMax) => update({ jminMin, jminMax })}
          />
          <Range
            label={t("generator.jmaxGap")}
            min={draft.jmaxGapMin} max={draft.jmaxGapMax} lower={1} upper={500}
            onChange={(jmaxGapMin, jmaxGapMax) => update({ jmaxGapMin, jmaxGapMax })}
          />
          <div className="grid gap-1.5">
            <Label htmlFor={`${idPrefix}-i-mode`}>{t("generator.iMode")}</Label>
            <Select
              value={draft.iMode}
              disabled={pending}
              onValueChange={(next) => update({ iMode: next as AwgGeneratorSettings["iMode"] })}
            >
              <SelectTrigger id={`${idPrefix}-i-mode`}>
            <SelectValue />
              </SelectTrigger>
              <SelectContent>
            {AWG_GENERATOR_I_MODES.map((mode) => (
              <SelectItem key={mode} value={mode}>{t(`generator.${mode}`)}</SelectItem>
            ))}
              </SelectContent>
            </Select>
          </div>
          {draft.iMode !== "issued" && draft.iMode !== "none" ? (
            <NumberField
              label={t("generator.iCount")} value={draft.iCount} min={1} max={5}
              onChange={(iCount) => update({ iCount })}
            />
          ) : null}
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{t("generator.cpa")}</span>
            <Switch
              aria-label={t("generator.cpa")}
              checked={draft.contentPaddingAddition !== null}
              onCheckedChange={(checked) => update({
            contentPaddingAddition: checked ? { min: 0, max: 0 } : null,
              })}
            />
          </div>
          {draft.contentPaddingAddition ? (
            <Range
              label="CPA" min={draft.contentPaddingAddition.min} max={draft.contentPaddingAddition.max}
              lower={0} upper={100}
              onChange={(min, max) => update({ contentPaddingAddition: { min, max } })}
            />
          ) : null}
          <div className="flex items-center justify-between gap-3 text-sm">
            <span>{t("generator.timings")}</span>
            <Switch
              aria-label={t("generator.timings")}
              checked={draft.timings !== null}
              onCheckedChange={(checked) => update({
            timings: checked ? {
              rekeyAfterTime: { min: 120, max: 120 },
              rekeyTimeout: { min: 5, max: 5 },
              rejectAfterTime: { min: 180, max: 180 },
              keepaliveTimeout: { min: 10, max: 10 },
              maxHandshakeAttempts: { min: 18, max: 18 },
            } : null,
              })}
            />
          </div>
          {timings ? (Object.keys(timings) as Array<keyof typeof timings>).map((key) => (
            <Range
              key={key} label={key} min={timings[key].min} max={timings[key].max}
              lower={key === "rejectAfterTime" ? 180 : 1} upper={65535}
              onChange={(min, max) => update({ timings: { ...timings, [key]: { min, max } } })}
            />
          )) : null}
        </>
      ) : null}
    </>
  );
}

/**
 * A level's profile and client MTU in one form: the node, an address, a
 * device rule, a user or a key. Either can inherit; `onSave` gets both.
 */
export function GeneratorEditor({
  value,
  mtu = null,
  inheritLabel,
  inheritedMtu,
  pending,
  onSave,
  idPrefix = "generator",
  requireOne = false,
}: {
  value: AwgGeneratorSettings | null;
  /** This level's own MTU; null inherits. */
  mtu?: number | null;
  inheritLabel: string;
  inheritedMtu: InheritedMtu;
  pending: boolean;
  onSave: (settings: AwgGeneratorSettings | null, mtu: number | null) => Promise<boolean>;
  idPrefix?: string;
  /** A device rule must set a profile, an MTU or both. */
  requireOne?: boolean;
}) {
  const { t } = useT();
  const [draft, setDraft] = React.useState(() => initialGeneratorDraft(value));
  const [ownMtu, setOwnMtu] = React.useState<number | null>(mtu);
  const [invalid, setInvalid] = React.useState<string | null>(null);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if ((draft && !awgGeneratorSettingsSchema.safeParse(draft).success) ||
      (ownMtu !== null && !awgClientMtuSchema.safeParse(ownMtu).success)) {
      setInvalid(t("generator.invalid"));
      return;
    }
    if (requireOne && draft === null && ownMtu === null) {
      setInvalid(t("awgRules.empty"));
      return;
    }
    try {
      if (await onSave(profileToSave(value, draft), ownMtu)) toast.success(t("generator.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("nodes.updateFailed"));
    }
  };
  return (
    <form onSubmit={(event) => void save(event)}>
      <fieldset disabled={pending} className="space-y-3">
        <GeneratorFields
          draft={draft}
          onDraftChange={(next) => { setDraft(next); setInvalid(null); }}
          pending={pending}
          inheritLabel={inheritLabel}
          idPrefix={idPrefix}
        />
        <MtuField
          id={`${idPrefix}-mtu`}
          value={ownMtu}
          inherited={inheritedMtuWith(draft, inheritedMtu)}
          disabled={pending}
          onChange={(next) => { setOwnMtu(next); setInvalid(null); }}
        />
        {invalid ? <p role="alert" className="text-sm text-destructive">{invalid}</p> : null}
        <div className="flex justify-end">
          <Button type="submit" disabled={pending}>{t("common.save")}</Button>
        </div>
      </fieldset>
    </form>
  );
}

function NumberField({ label, value, min, max, onChange }: {
  label: string;
  value: number;
  min: number;
  max: number;
  onChange: (value: number) => void;
}) {
  return (
    <label className="grid min-w-0 gap-1 text-sm">
      {label}
      <Input
        type="number" required min={min} max={max}
        value={Number.isNaN(value) ? "" : value}
        onChange={(event) => onChange(event.target.valueAsNumber)}
      />
    </label>
  );
}

function Range({ label, min, max, lower, upper, onChange }: {
  label: string;
  min: number;
  max: number;
  lower: number;
  upper: number;
  onChange: (min: number, max: number) => void;
}) {
  const { t } = useT();
  return (
    <fieldset className="grid grid-cols-2 gap-2">
      <legend className="mb-1 text-sm font-medium">{label}</legend>
      <NumberField label={t("generator.min")} value={min} min={lower} max={upper} onChange={(value) => onChange(value, max)} />
      <NumberField label={t("generator.max")} value={max} min={lower} max={upper} onChange={(value) => onChange(min, value)} />
    </fieldset>
  );
}
