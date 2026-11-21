"use client";

import * as React from "react";
import { Settings2 } from "lucide-react";
import { toast } from "sonner";
import {
  AWG_GENERATOR_I_MODES,
  AWG_GENERATOR_PRESETS,
  awgGeneratorPresets,
  awgGeneratorSettingsSchema,
  type AwgGeneratorSettings,
} from "@amnezia/contracts";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
};

/** The target picker's value for the node itself; an item value cannot be empty. */
const NODE_SCOPE = "node";

type Props = {
  value: AwgGeneratorSettings | null;
  endpoints: readonly GeneratorEndpoint[];
  onSave: (endpointId: string | null, settings: AwgGeneratorSettings | null) => Promise<void>;
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

export function NodeGeneratorSettings({ value, endpoints, onSave }: Props) {
  const { t } = useT();
  const [open, setOpen] = React.useState(false);
  const [scope, setScope] = React.useState("");
  const [pending, setPending] = React.useState(false);
  const pendingRef = React.useRef(false);
  const selected = endpoints.find((endpoint) => endpoint.id === scope);
  return (
    <>
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={pending}
        onClick={() => {
          if (pendingRef.current) return;
          setScope("");
          setOpen(true);
        }}
      >
        <Settings2 className="size-4" /> {t("generator.title")}
      </Button>
      <Dialog open={open} onOpenChange={(next) => {
        if (!pendingRef.current) setOpen(next);
      }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("generator.title")}</DialogTitle>
            <DialogDescription>{t("generator.description")}</DialogDescription>
          </DialogHeader>
          <div className="grid gap-1.5">
            <Label htmlFor="generator-target">{t("generator.target")}</Label>
            <Select
              value={scope || NODE_SCOPE}
              disabled={pending}
              onValueChange={(next) => {
                if (!pendingRef.current) setScope(next === NODE_SCOPE ? "" : next);
              }}
            >
              <SelectTrigger id="generator-target">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={NODE_SCOPE}>{t("generator.node")}</SelectItem>
                {endpoints.map((endpoint) => (
                  <SelectItem key={endpoint.id} value={endpoint.id}>{endpoint.name}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <GeneratorEditor
            key={`${open}-${scope}`}
            value={scope ? selected?.awgGenerator ?? null : value}
            inherited={Boolean(scope)}
            pending={pending}
            onSave={async (settings) => {
              if (pendingRef.current) return false;
              pendingRef.current = true;
              setPending(true);
              try {
                await onSave(scope || null, settings);
                setOpen(false);
                return true;
              } finally {
                pendingRef.current = false;
                setPending(false);
              }
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

export function GeneratorEditor({ value, inherited, pending, onSave }: {
  value: AwgGeneratorSettings | null;
  inherited: boolean;
  pending: boolean;
  onSave: (settings: AwgGeneratorSettings | null) => Promise<boolean>;
}) {
  const { t } = useT();
  const presets = awgGeneratorPresets();
  const [draft, setDraft] = React.useState<AwgGeneratorSettings | null>(() =>
    value && value.preset === "randomized" && value.iMode === "dns_query"
      ? { ...value, iMode: "mixed" }
      : value,
  );
  const [invalid, setInvalid] = React.useState(false);
  const update = (change: Partial<AwgGeneratorSettings>) => {
    setDraft((current) => current ? editGeneratorDraft(current, change) : current);
    setInvalid(false);
  };
  const randomization = keyRandomizationState(draft);
  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    if (draft && !awgGeneratorSettingsSchema.safeParse(draft).success) {
      setInvalid(true);
      return;
    }
    try {
      if (await onSave(draft)) toast.success(t("generator.saved"));
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t("nodes.updateFailed"));
    }
  };
  const timings = draft?.timings;
  return (
    <form onSubmit={(event) => void save(event)}>
      <fieldset disabled={pending} className="space-y-3">
      <div className="grid gap-1.5">
        <Label htmlFor="generator-preset">{t("generator.preset")}</Label>
        <Select
          value={draft?.preset ?? "inherit"}
          disabled={pending}
          onValueChange={(next) => {
            const preset = presets.find((entry) => entry.id === next);
            setDraft(preset ? structuredClone(preset.settings) : null);
            setInvalid(false);
          }}
        >
          <SelectTrigger id="generator-preset">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="inherit">
              {t(inherited ? "generator.inheritNode" : "generator.inheritDefault")}
            </SelectItem>
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
      {draft ? (
        <>
          <NumberField
            label={t("generator.mtu")}
            value={draft.mtu}
            min={1280}
            max={1420}
            onChange={(mtu) => update({ mtu })}
          />
          {draft.preset !== "issued" ? (
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
                <Label htmlFor="generator-i-mode">{t("generator.iMode")}</Label>
                <Select
                  value={draft.iMode}
                  disabled={pending}
                  onValueChange={(next) => update({ iMode: next as AwgGeneratorSettings["iMode"] })}
                >
                  <SelectTrigger id="generator-i-mode">
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
      ) : null}
      {invalid ? <p role="alert" className="text-sm text-destructive">{t("generator.invalid")}</p> : null}
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
