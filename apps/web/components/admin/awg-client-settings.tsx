"use client";

import * as React from "react";
import { ChevronDown, ListTree, SlidersHorizontal } from "lucide-react";
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
  AwgSourcedSettings,
  inheritedMtuWith,
  MtuField,
  useAwgSourceLabel,
  type InheritedMtu,
} from "@/components/admin/awg-mtu-field";
import { DeviceRulesEditor, type RulesInherited } from "@/components/admin/awg-device-rules-editor";
import { ClientParametersDialog, type ClientParametersTarget } from "@/components/admin/client-parameters-dialog";
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
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { deviceTypeLabel } from "@/lib/device-type";
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

/**
 * The levels a new key inherits from, resolved the way the API resolves them:
 * the owner's rule for the device type, the owner, the address's rule, the
 * address, the node.
 */
export const inheritedForNewKey = (levels: {
  user: (AwgClientSettingsValue & { awgDeviceRules?: AwgDeviceRules | null }) | null;
  deviceType: string;
  endpoint: { awgGenerator?: AwgGeneratorSettings | null; awgMtu?: number | null; awgDeviceRules?: AwgDeviceRules | null } | null;
  node: { awgGenerator?: AwgGeneratorSettings | null; awgMtu?: number | null } | null;
}): ResolvedAwgClientSettings => resolveAwgClientSettings({
  userDevice: levels.user ? deviceRuleFor(levels.user.awgDeviceRules, levels.deviceType) : null,
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

/** A user's own settings: profile, MTU and per-device-type rules; null inherits. */
export type UserClientSettings = AwgClientSettingsValue & { awgDeviceRules: AwgDeviceRules | null };

/** One `users/set-config` change: only the fields it names are written. */
export type UserClientConfigChange = Partial<UserClientSettings>;

/** Saving the rules replaces the user's whole map; null clears every rule. */
export const deviceRulesChange = (rules: AwgDeviceRules | null): UserClientConfigChange => ({ awgDeviceRules: rules });

/**
 * What a user's device rule leaves to the levels under it: the user's own
 * profile and MTU where set, otherwise each key's address and server.
 */
export const userRulesInherited = (
  user: AwgClientSettingsValue,
  presetLabel: (settings: AwgGeneratorSettings | null) => string,
): RulesInherited => ({
  profileLabel: user.awgGenerator ? presetLabel(user.awgGenerator) : null,
  source: user.awgGenerator ? "user" : "keys",
  mtu: user.awgMtu !== null ? { mtu: user.awgMtu, source: "user" } : { mtu: null, source: "keys" },
});

/** A key as the "Now in effect" list reads it, from the admin key list. */
export type InEffectKey = {
  id: string;
  deviceLabel: string;
  deviceType: string;
  state: string;
  endpointName?: string | null;
  config?: AdminKeyClientConfig | null;
};

/** The user's AWG 3.1 keys whose config can still be downloaded. */
const keysInEffect = (keys: readonly InEffectKey[]) =>
  keys.filter((key) => key.config && key.state !== "revoked" && key.state !== "revoking");

/**
 * What each of the user's AWG 3.1 keys gets now: the profile and MTU with the
 * level each comes from, and the way to its full parameters.
 */
export function UserKeysInEffect({ keys, pending = false, onShowParameters }: {
  keys: readonly InEffectKey[];
  pending?: boolean;
  onShowParameters: (key: InEffectKey) => void;
}) {
  const { t } = useT();
  const presetLabel = usePresetLabel();
  const list = keysInEffect(keys);
  return (
    <section className="space-y-2" aria-labelledby="user-keys-in-effect">
      <h3 id="user-keys-in-effect" className="text-sm font-medium">{t("awgUser.inEffect")}</h3>
      <p className="text-xs text-muted-foreground">{t("awgUser.inEffectHint")}</p>
      {list.length === 0 ? (
        <p className="rounded-lg border border-dashed p-4 text-center text-sm text-muted-foreground">
          {t("awgUser.noKeys")}
        </p>
      ) : (
        <ul className="space-y-1.5">
          {list.map((key) => {
            const config = key.config!;
            return (
              <li key={key.id} className="rounded-lg border bg-well px-3 py-2 shadow-[var(--inset-shadow)]">
                <div className="flex items-start gap-2">
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
                      <span className="truncate text-sm font-medium">
                        {key.deviceLabel || deviceTypeLabel(t, key.deviceType)}
                      </span>
                      {key.deviceLabel ? (
                        <Badge variant="secondary" className="shrink-0 px-1.5 py-0 text-[10px]">
                          {deviceTypeLabel(t, key.deviceType)}
                        </Badge>
                      ) : null}
                      {key.endpointName ? (
                        <span className="truncate text-xs text-muted-foreground">{key.endpointName}</span>
                      ) : null}
                    </div>
                    <AwgSourcedSettings
                      className="text-xs"
                      profile={presetLabel(config.awgGenerator)}
                      profileSource={config.profileFrom ?? "default"}
                      mtu={config.mtu}
                      mtuSource={config.mtuFrom}
                    />
                  </div>
                  <Button
                    type="button" size="sm" variant="ghost" className="shrink-0 px-2"
                    disabled={pending}
                    onClick={() => onShowParameters(key)}
                  >
                    <ListTree className="size-4" />
                    {t("clientParams.open")}
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

export type UserSettingsTab = "profile" | "devices" | "keys";

/**
 * The body of a user's settings dialog, one level per tab: the profile and
 * MTU over every key, the per-device-type rules, and what each key gets now.
 * Saving keeps the dialog open, so the "Keys" tab shows the result.
 */
export function AwgUserSettingsPanel({ user, keys, pending, onSave, onShowParameters, initialTab = "profile" }: {
  user: UserClientSettings;
  keys: readonly InEffectKey[];
  pending: boolean;
  onSave: (change: UserClientConfigChange) => Promise<boolean>;
  onShowParameters: (key: InEffectKey) => void;
  initialTab?: UserSettingsTab;
}) {
  const { t } = useT();
  const presetLabel = usePresetLabel();
  // Remounts the profile form after "Inherit everything", which it cannot see coming.
  const [profileRevision, setProfileRevision] = React.useState(0);
  const isSet = user.awgGenerator !== null || user.awgMtu !== null;
  const ruleCount = Object.keys(user.awgDeviceRules ?? {}).length;
  const keyCount = keysInEffect(keys).length;
  const count = (value: number) =>
    value > 0 ? <span className="tabular text-xs font-normal text-muted-foreground">{value}</span> : null;
  return (
    <Tabs defaultValue={initialTab}>
      <TabsList className="grid h-auto w-full grid-cols-3">
        <TabsTrigger value="profile" disabled={pending} className="whitespace-normal px-2 text-xs leading-tight sm:text-sm">
          {t("awgUser.tab.profile")}
        </TabsTrigger>
        <TabsTrigger value="devices" disabled={pending} className="whitespace-normal px-2 text-xs leading-tight sm:text-sm">
          {t("awgUser.tab.devices")}{count(ruleCount)}
        </TabsTrigger>
        <TabsTrigger value="keys" disabled={pending} className="whitespace-normal px-2 text-xs leading-tight sm:text-sm">
          {t("awgUser.tab.keys")}{count(keyCount)}
        </TabsTrigger>
      </TabsList>
      <TabsContent value="profile" className="space-y-3">
        <GeneratorEditor
          key={profileRevision}
          idPrefix="user-settings"
          value={user.awgGenerator}
          mtu={user.awgMtu}
          inheritLabel={t("awgSettings.inheritKeyLevels")}
          inheritedMtu={USER_INHERITED.mtu}
          pending={pending}
          onSave={(awgGenerator, awgMtu) => onSave({ awgGenerator, awgMtu })}
        />
        {isSet ? (
          <div className="flex justify-start border-t pt-3">
            <Button
              type="button" variant="ghost" size="sm" disabled={pending}
              onClick={() => void onSave({ awgGenerator: null, awgMtu: null }).then((saved) => {
                if (saved) setProfileRevision((value) => value + 1);
              })}
            >
              {t("awgSettings.resetAll")}
            </Button>
          </div>
        ) : null}
      </TabsContent>
      <TabsContent value="devices">
        <DeviceRulesEditor
          level="user"
          className="border-t-0 pt-0"
          rules={user.awgDeviceRules}
          inherited={userRulesInherited(user, presetLabel)}
          pending={pending}
          onSave={(rules) => onSave(deviceRulesChange(rules))}
        />
      </TabsContent>
      <TabsContent value="keys">
        <UserKeysInEffect keys={keys} pending={pending} onShowParameters={onShowParameters} />
      </TabsContent>
    </Tabs>
  );
}

/** A user's settings dialog, with each key's parameters one click away. */
export function AwgUserSettingsDialog({ open, user, keys, onClose, onSave }: {
  open: boolean;
  user: UserClientSettings;
  keys: readonly InEffectKey[];
  onClose: () => void;
  onSave: (change: UserClientConfigChange) => Promise<boolean>;
}) {
  const { t } = useT();
  const [pending, setPending] = React.useState(false);
  const [parameters, setParameters] = React.useState<ClientParametersTarget | null>(null);
  const pendingRef = React.useRef(false);
  const save = async (change: UserClientConfigChange) => {
    if (pendingRef.current) return false;
    pendingRef.current = true;
    setPending(true);
    try {
      return await onSave(change);
    } finally {
      pendingRef.current = false;
      setPending(false);
    }
  };
  return (
    <>
      <Dialog open={open} onOpenChange={(next) => { if (!next && !pendingRef.current) onClose(); }}>
        <DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("awgSettings.userTitle")}</DialogTitle>
            <DialogDescription>{t("awgSettings.userDescription")}</DialogDescription>
          </DialogHeader>
          <p className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
            {t("awgSettings.reimportNote")}
          </p>
          <AwgUserSettingsPanel
            user={user}
            keys={keys}
            pending={pending}
            onSave={save}
            onShowParameters={(key) => {
              if (pendingRef.current) return;
              setParameters({
                kind: "key",
                id: key.id,
                label: key.deviceLabel || deviceTypeLabel(t, key.deviceType),
              });
            }}
          />
        </DialogContent>
      </Dialog>
      <ClientParametersDialog target={parameters} onClose={() => setParameters(null)} />
    </>
  );
}
