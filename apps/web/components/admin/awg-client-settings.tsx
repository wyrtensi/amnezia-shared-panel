"use client";

import * as React from "react";
import { ChevronDown, SlidersHorizontal } from "lucide-react";
import {
  awgClientMtuSchema,
  awgGeneratorSettingsSchema,
  deviceRuleFor,
  resolveAwgClientSettings,
  type AwgDeviceRules,
  type AwgGeneratorSettings,
  type ResolvedAwgClientSettings,
} from "@amnezia/contracts";
import {
  inheritedMtuWith,
  MtuField,
  useAwgSourceLabel,
  type InheritedMtu,
} from "@/components/admin/awg-mtu-field";
import {
  GeneratorEditor,
  GeneratorFields,
  usePresetLabel,
} from "@/components/admin/node-generator-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

/** A user's or a key's own settings; null inherits. */
export type AwgClientSettingsValue = {
  awgGenerator: AwgGeneratorSettings | null;
  awgMtu: number | null;
};

/** What the admin key list reports for an AWG 3.1 key. */
export type AdminKeyClientConfig = ResolvedAwgClientSettings & {
  probeChecked: boolean;
  inherited?: ResolvedAwgClientSettings;
};

/** What a level inherits, for the editor's "inherit" options. */
export type InheritedClientSettings = {
  /** The inherited profile's label, or null when it differs per key. */
  profileLabel: string | null;
  source: Parameters<ReturnType<typeof useAwgSourceLabel>>[0];
  mtu: InheritedMtu;
};

/** A new key's own settings are sendable: a valid profile, and an MTU in range when one is set. */
export const clientSettingsValid = (value: AwgClientSettingsValue): boolean =>
  (value.awgGenerator === null || awgGeneratorSettingsSchema.safeParse(value.awgGenerator).success) &&
  (value.awgMtu === null || awgClientMtuSchema.safeParse(value.awgMtu).success);

/** The levels a new key inherits from, resolved the way the API resolves them. */
export const inheritedForNewKey = (levels: {
  user: AwgClientSettingsValue | null;
  deviceType: string;
  endpoint: { awgGenerator?: AwgGeneratorSettings | null; awgMtu?: number | null; awgDeviceRules?: AwgDeviceRules | null } | null;
  node: { awgGenerator?: AwgGeneratorSettings | null; awgMtu?: number | null } | null;
}): ResolvedAwgClientSettings => resolveAwgClientSettings({
  user: levels.user,
  device: levels.endpoint ? deviceRuleFor(levels.endpoint.awgDeviceRules, levels.deviceType) : null,
  address: levels.endpoint,
  node: levels.node,
});

const useInheritedOf = () => {
  const presetLabel = usePresetLabel();
  return (resolved: ResolvedAwgClientSettings): InheritedClientSettings => ({
    profileLabel: presetLabel(resolved.awgGenerator),
    source: resolved.profileFrom ?? "default",
    mtu: { mtu: resolved.mtu, source: resolved.mtuFrom, profile: resolved.awgGenerator },
  });
};

/**
 * A user's or a key's profile and MTU in a dialog. Saving applies to the next
 * export; a device that already imported the config imports it again.
 */
export function AwgClientSettingsDialog({ open, title, description, value, inherited, onClose, onSave }: {
  open: boolean;
  title: string;
  description: string;
  value: AwgClientSettingsValue;
  inherited: InheritedClientSettings;
  onClose: () => void;
  onSave: (value: AwgClientSettingsValue) => Promise<boolean>;
}) {
  const { t } = useT();
  const sourceLabel = useAwgSourceLabel();
  const [pending, setPending] = React.useState(false);
  const save = async (next: AwgClientSettingsValue) => {
    setPending(true);
    try {
      const saved = await onSave(next);
      if (saved) onClose();
      return saved;
    } finally {
      setPending(false);
    }
  };
  const isSet = value.awgGenerator !== null || value.awgMtu !== null;
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !pending) onClose(); }}>
      <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          {t("awgSettings.reimportNote")}
        </p>
        <GeneratorEditor
          key={`${open}`}
          idPrefix="client-settings"
          value={value.awgGenerator}
          mtu={value.awgMtu}
          inheritLabel={inherited.profileLabel === null
            ? t("awgSettings.inheritKeyLevels")
            : t("awgSettings.inheritFrom", { source: sourceLabel(inherited.source), profile: inherited.profileLabel })}
          inheritedMtu={inherited.mtu}
          pending={pending}
          onSave={(awgGenerator, awgMtu) => save({ awgGenerator, awgMtu })}
        />
        {isSet ? (
          <div className="flex justify-start border-t pt-3">
            <Button
              type="button" variant="ghost" size="sm" disabled={pending}
              onClick={() => void save({ awgGenerator: null, awgMtu: null })}
            >
              {t("awgSettings.resetAll")}
            </Button>
          </div>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/**
 * One line on an admin key row: the profile and MTU its exports use and the
 * level each comes from, and a marker when a hand-set level applies, which
 * the probe never measures.
 */
export function AwgKeySettingsSummary({ config, className }: { config: AdminKeyClientConfig; className?: string }) {
  const { t } = useT();
  const presetLabel = usePresetLabel();
  const sourceLabel = useAwgSourceLabel();
  return (
    <span className={cn("inline-flex min-w-0 flex-wrap items-center gap-1.5", className)}>
      <span className="min-w-0 break-words">
        {t("awgSettings.summary", {
          profile: presetLabel(config.awgGenerator),
          profileSource: sourceLabel(config.profileFrom ?? "default"),
          mtu: config.mtu,
          mtuSource: sourceLabel(config.mtuFrom),
        })}
      </span>
      {config.probeChecked ? null : (
        <Tooltip>
          <TooltipTrigger asChild>
            <Badge variant="warning" className="shrink-0">{t("awgSettings.manual")}</Badge>
          </TooltipTrigger>
          <TooltipContent>{t("awgSettings.manualTip")}</TooltipContent>
        </Tooltip>
      )}
    </span>
  );
}

/** Open the key's settings dialog from its row. */
export function AwgKeySettingsAction({ label, onClick }: { label: string; onClick: () => void }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button size="icon" variant="ghost" className="size-8" aria-label={label} onClick={onClick}>
          <SlidersHorizontal className="h-4 w-4" />
        </Button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

/** The inherited settings a key's dialog shows, from the admin key list. */
export const useKeyInherited = () => {
  const inheritedOf = useInheritedOf();
  return (config: AdminKeyClientConfig): InheritedClientSettings =>
    inheritedOf(config.inherited ?? config);
};

/** A user's dialog inherits per key: from each key's address and server. */
export const USER_INHERITED: InheritedClientSettings = {
  profileLabel: null,
  source: "keys",
  mtu: { mtu: null, source: "keys" },
};

/**
 * The optional profile and MTU of a key being issued (administrators only):
 * collapsed by default, it names what the key inherits and says the probe
 * does not measure a key's own settings.
 */
export function AwgNewKeySettings({ value, onChange, inherited, pending, idPrefix }: {
  value: AwgClientSettingsValue;
  onChange: (value: AwgClientSettingsValue) => void;
  /** Null where the server settings are not known (the cabinet wizard). */
  inherited: ResolvedAwgClientSettings | null;
  pending: boolean;
  idPrefix: string;
}) {
  const { t } = useT();
  const inheritedOf = useInheritedOf();
  const sourceLabel = useAwgSourceLabel();
  const isSet = value.awgGenerator !== null || value.awgMtu !== null;
  const [open, setOpen] = React.useState(isSet);
  const info: InheritedClientSettings = inherited
    ? inheritedOf(inherited)
    : { profileLabel: null, source: "levels", mtu: { mtu: null, source: "levels" } };
  return (
    <div className="rounded-lg border bg-well px-3 py-2 shadow-[var(--inset-shadow)]">
      <button
        type="button"
        className="flex w-full items-center justify-between gap-2 text-left text-sm font-medium"
        aria-expanded={open}
        aria-controls={`${idPrefix}-body`}
        onClick={() => setOpen(!open)}
      >
        <span className="flex min-w-0 flex-wrap items-center gap-1.5">
          <SlidersHorizontal className="size-4 shrink-0 text-muted-foreground" />
          {t("awgSettings.keyTitle")}
          {isSet ? <Badge variant="warning">{t("awgSettings.manual")}</Badge> : null}
        </span>
        <ChevronDown className={cn("size-4 shrink-0 transition-transform", open && "rotate-180")} />
      </button>
      {open ? (
        <div id={`${idPrefix}-body`} className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">{t("awgSettings.keyHint")}</p>
          <GeneratorFields
            idPrefix={idPrefix}
            draft={value.awgGenerator}
            onDraftChange={(awgGenerator) => onChange({ ...value, awgGenerator })}
            pending={pending}
            inheritLabel={info.profileLabel === null
              ? t("awgSettings.inheritLevels")
              : t("awgSettings.inheritFrom", { source: sourceLabel(info.source), profile: info.profileLabel })}
          />
          <MtuField
            id={`${idPrefix}-mtu`}
            value={value.awgMtu}
            inherited={inheritedMtuWith(value.awgGenerator, info.mtu)}
            disabled={pending}
            onChange={(awgMtu) => onChange({ ...value, awgMtu })}
          />
        </div>
      ) : null}
    </div>
  );
}
