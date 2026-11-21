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
import { Switch } from "@/components/ui/switch";
import { useT } from "@/lib/i18n/provider";

export type GeneratorEndpoint = {
  id: string;
  name: string;
  awgGenerator?: AwgGeneratorSettings | null;
};

type Props = {
  value: AwgGeneratorSettings | null;
  endpoints: readonly GeneratorEndpoint[];
  onSave: (endpointId: string | null, settings: AwgGeneratorSettings | null) => Promise<void>;
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
          <label className="grid gap-1.5 text-sm font-medium">
            {t("generator.target")}
            <select
              className="h-9 w-full rounded-md border bg-background px-3 text-sm"
              value={scope}
              disabled={pending}
              onChange={(event) => {
                if (!pendingRef.current) setScope(event.target.value);
              }}
            >
              <option value="">{t("generator.node")}</option>
              {endpoints.map((endpoint) => (
                <option key={endpoint.id} value={endpoint.id}>{endpoint.name}</option>
              ))}
            </select>
          </label>
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

function GeneratorEditor({ value, inherited, pending, onSave }: {
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
    setDraft((current) => current ? {
      ...current,
      ...change,
      preset: current.preset === "randomized" && change.iMode === undefined
        ? "randomized"
        : "custom",
    } : current);
    setInvalid(false);
  };
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
      <label className="grid gap-1.5 text-sm font-medium">
        {t("generator.preset")}
        <select
          className="h-9 w-full rounded-md border bg-background px-3 text-sm"
          value={draft?.preset ?? "inherit"}
          onChange={(event) => {
            const preset = presets.find((entry) => entry.id === event.target.value);
            setDraft(preset ? structuredClone(preset.settings) : null);
            setInvalid(false);
          }}
        >
          <option value="inherit">
            {t(inherited ? "generator.inheritNode" : "generator.inheritDefault")}
          </option>
          {AWG_GENERATOR_PRESETS.map((id) => (
            <option key={id} value={id}>{t(`generator.${id}`)}</option>
          ))}
        </select>
      </label>
      {draft ? (
        <>
          <NumberField
            label={t("generator.mtu")}
            value={draft.mtu}
            min={1280}
            max={1420}
            onChange={(mtu) => {
              setDraft((current) => current ? { ...current, mtu } : current);
              setInvalid(false);
            }}
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
              <label className="grid gap-1.5 text-sm font-medium">
                {t("generator.iMode")}
                <select
                  className="h-9 w-full rounded-md border bg-background px-3 text-sm"
                  value={draft.iMode}
                  onChange={(event) => update({ iMode: event.target.value as AwgGeneratorSettings["iMode"] })}
                >
                  {AWG_GENERATOR_I_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {t(`generator.${mode}`)}
                    </option>
                  ))}
                </select>
              </label>
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
