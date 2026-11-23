"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import {
  DEVICE_TYPE_ORDER,
  type AwgDeviceRule,
  type AwgDeviceRules,
  type AwgGeneratorSettings,
} from "@amnezia/contracts";
import { useAwgSourceLabel, type InheritedMtu } from "@/components/admin/awg-mtu-field";
import { GeneratorEditor, usePresetLabel } from "@/components/admin/node-generator-settings";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deviceTypeLabel } from "@/lib/device-type";
import { useT } from "@/lib/i18n/provider";
import { cn } from "@/lib/utils";

type RuledDeviceType = keyof AwgDeviceRules;

/** Device types a rule can be set for, in the order the issue dialogs offer them ("unspecified" is not one). */
export const RULE_DEVICE_TYPES: readonly RuledDeviceType[] = DEVICE_TYPE_ORDER;

/**
 * What a key of a ruled type gets for what its rule leaves unset: the level
 * the rules belong to (the address, the user) and everything under it. A
 * null `profileLabel` is a profile that differs per key.
 */
export type RulesInherited = {
  profileLabel: string | null;
  source: InheritedMtu["source"];
  mtu: InheritedMtu;
};

/** What an address gives its keys without a device rule. */
export const addressRulesInherited = (
  address: { awgGenerator: AwgGeneratorSettings | null; mtu: number; mtuFrom: InheritedMtu["source"] },
  presetLabel: (settings: AwgGeneratorSettings | null) => string,
): RulesInherited => ({
  profileLabel: presetLabel(address.awgGenerator),
  source: "address",
  mtu: { mtu: address.mtu, source: address.mtuFrom, profile: address.awgGenerator },
});

/** Rules in display order, the ones set and the ones still free. */
export const deviceRuleRows = (rules: AwgDeviceRules | null) => ({
  set: RULE_DEVICE_TYPES.filter((type) => rules?.[type]),
  free: RULE_DEVICE_TYPES.filter((type) => !rules?.[type]),
});

/** The rules with one device type's rule replaced, or removed when `rule` is null; null when none is left. */
export const withDeviceRule = (
  rules: AwgDeviceRules | null,
  type: RuledDeviceType,
  rule: AwgDeviceRule | null,
): AwgDeviceRules | null => {
  const next: AwgDeviceRules = { ...(rules ?? {}) };
  if (rule) next[type] = rule;
  else delete next[type];
  return Object.keys(next).length > 0 ? next : null;
};

/**
 * Per-device-type profile and MTU on one address or one user, for that
 * level's keys of the type. Each rule is a row: what it sets, edit and
 * remove; a free type is added from the select below. The probe does not
 * measure these rules.
 */
export function DeviceRulesEditor({ rules, inherited, pending, onSave, level = "address", className }: {
  rules: AwgDeviceRules | null;
  inherited: RulesInherited;
  pending: boolean;
  onSave: (rules: AwgDeviceRules | null) => Promise<boolean>;
  /** Whose rules these are; words the hint and the empty state. */
  level?: "address" | "user";
  className?: string;
}) {
  const { t } = useT();
  const presetLabel = usePresetLabel();
  const sourceLabel = useAwgSourceLabel();
  const inheritedProfile = inherited.source === "address"
    ? t("awgRules.profileFromAddress")
    : inherited.source === "user" ? t("awgRules.profileFromUser") : t("awgRules.profileFromKeys");
  const inheritedMtu = inherited.mtu.mtu === null
    ? sourceLabel(inherited.mtu.source)
    : `${inherited.mtu.mtu} (${sourceLabel(inherited.mtu.source)})`;
  const [editing, setEditing] = React.useState<RuledDeviceType | null>(null);
  const { set, free } = deviceRuleRows(rules);
  const save = async (type: RuledDeviceType, rule: AwgDeviceRule | null) => {
    const saved = await onSave(withDeviceRule(rules, type, rule));
    if (saved) setEditing(null);
    return saved;
  };
  const editor = (type: RuledDeviceType) => (
    <GeneratorEditor
      key={`rule-${type}`}
      idPrefix={`${level}-rule-${type}`}
      value={rules?.[type]?.awgGenerator ?? null}
      mtu={rules?.[type]?.awgMtu ?? null}
      inheritLabel={inherited.profileLabel === null
        ? t("awgSettings.inheritKeyLevels")
        : t("awgSettings.inheritFrom", { source: sourceLabel(inherited.source), profile: inherited.profileLabel })}
      inheritedMtu={inherited.mtu}
      pending={pending}
      requireOne
      onSave={(awgGenerator, awgMtu) => save(type, { awgGenerator, awgMtu })}
    />
  );
  return (
    <section className={cn("space-y-3 border-t pt-4", className)} aria-labelledby={`${level}-device-rules-title`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id={`${level}-device-rules-title`} className="text-sm font-medium">{t("awgRules.title")}</h3>
        <Badge variant="outline">{t("awgSettings.notProbed")}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t(level === "user" ? "awgRules.userHint" : "awgRules.hint")}</p>
      {set.length === 0 && editing === null ? (
        <p className="text-sm text-muted-foreground">{t(level === "user" ? "awgRules.userNone" : "awgRules.none")}</p>
      ) : null}
      {set.map((type) => {
        const rule = rules?.[type];
        return (
          <div key={type} className="rounded-lg border bg-well px-3 py-2 shadow-[var(--inset-shadow)]">
            <div className="flex items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{deviceTypeLabel(t, type)}</span>
              <div className="flex shrink-0 gap-1">
                <Button
                  type="button" size="sm" variant="ghost" disabled={pending}
                  onClick={() => setEditing(editing === type ? null : type)}
                >
                  {t("common.edit")}
                </Button>
                <Button
                  type="button" size="sm" variant="ghost" disabled={pending}
                  className="text-muted-foreground hover:text-destructive"
                  onClick={() => void save(type, null)}
                >
                  {t("awgRules.remove")}
                </Button>
              </div>
            </div>
            <p className="mt-0.5 text-xs text-muted-foreground">
              {t("awgRules.summary", {
                profile: rule?.awgGenerator ? presetLabel(rule.awgGenerator) : inheritedProfile,
                mtu: rule?.awgMtu ?? inheritedMtu,
              })}
            </p>
            {editing === type ? <div className="mt-3">{editor(type)}</div> : null}
          </div>
        );
      })}
      {editing !== null && !rules?.[editing] ? (
        <div className="rounded-lg border px-3 py-3">
          <div className="mb-3 flex items-center justify-between gap-2">
            <span className="text-sm font-medium">{deviceTypeLabel(t, editing)}</span>
            <Button type="button" size="sm" variant="ghost" onClick={() => setEditing(null)}>
              {t("common.cancel")}
            </Button>
          </div>
          {editor(editing)}
        </div>
      ) : null}
      {free.length > 0 && (editing === null || Boolean(rules?.[editing])) ? (
        <Select
          value=""
          disabled={pending}
          onValueChange={(next) => setEditing(next as RuledDeviceType)}
        >
          <SelectTrigger
            aria-label={t("awgRules.add")}
            className="justify-start gap-2 text-muted-foreground sm:max-w-xs [&>svg:last-child]:ml-auto"
          >
            <Plus className="size-4 shrink-0" />
            <SelectValue placeholder={t("awgRules.add")} />
          </SelectTrigger>
          <SelectContent>
            {free.map((type) => (
              <SelectItem key={type} value={type}>{deviceTypeLabel(t, type)}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      ) : null}
    </section>
  );
}
