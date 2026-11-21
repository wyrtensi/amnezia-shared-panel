"use client";

import * as React from "react";
import { Plus } from "lucide-react";
import {
  DEVICE_TYPE_ORDER,
  type AwgDeviceRule,
  type AwgDeviceRules,
  type AwgGeneratorSettings,
} from "@amnezia/contracts";
import { useAwgSourceLabel, type AwgSettingSource } from "@/components/admin/awg-mtu-field";
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

type RuledDeviceType = keyof AwgDeviceRules;

/** Device types a rule can be set for, in the order the issue dialogs offer them ("unspecified" is not one). */
export const RULE_DEVICE_TYPES: readonly RuledDeviceType[] = DEVICE_TYPE_ORDER;

/** What the address gives a key without a device rule. */
export type AddressSettings = {
  awgGenerator: AwgGeneratorSettings | null;
  mtu: number;
  mtuFrom: AwgSettingSource;
};

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
 * Per-device-type profile and MTU on one address, for that address's keys of
 * the type. Each rule is a row: what it sets, edit and remove; a free type is
 * added from the select below. The probe does not measure these rules.
 */
export function DeviceRulesEditor({ rules, inherited, pending, onSave }: {
  rules: AwgDeviceRules | null;
  inherited: AddressSettings;
  pending: boolean;
  onSave: (rules: AwgDeviceRules | null) => Promise<boolean>;
}) {
  const { t } = useT();
  const presetLabel = usePresetLabel();
  const sourceLabel = useAwgSourceLabel();
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
      idPrefix={`rule-${type}`}
      value={rules?.[type]?.awgGenerator ?? null}
      mtu={rules?.[type]?.awgMtu ?? null}
      inheritLabel={t("awgSettings.inheritFrom", {
        source: t("awgSettings.from.address"),
        profile: presetLabel(inherited.awgGenerator),
      })}
      inheritedMtu={{ mtu: inherited.mtu, source: inherited.mtuFrom }}
      pending={pending}
      requireOne
      onSave={(awgGenerator, awgMtu) => save(type, { awgGenerator, awgMtu })}
    />
  );
  return (
    <section className="space-y-3 border-t pt-4" aria-labelledby="device-rules-title">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 id="device-rules-title" className="text-sm font-medium">{t("awgRules.title")}</h3>
        <Badge variant="outline">{t("awgSettings.notProbed")}</Badge>
      </div>
      <p className="text-xs text-muted-foreground">{t("awgRules.hint")}</p>
      {set.length === 0 && editing === null ? (
        <p className="text-sm text-muted-foreground">{t("awgRules.none")}</p>
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
                profile: rule?.awgGenerator ? presetLabel(rule.awgGenerator) : t("awgRules.profileFromAddress"),
                mtu: rule?.awgMtu ?? `${inherited.mtu} (${sourceLabel(inherited.mtuFrom)})`,
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
