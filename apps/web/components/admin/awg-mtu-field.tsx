"use client";

import * as React from "react";
import { AWG_DEFAULT_CLIENT_MTU, type AwgConfigLevelName } from "@amnezia/contracts";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useT } from "@/lib/i18n/provider";

/** Where an inherited value comes from, as `resolveAwgClientSettings` reports it. */
export type AwgSettingSource = AwgConfigLevelName | "profile" | "default";

/**
 * What a level inherits: the value and where it comes from. `mtu` is unknown
 * where it differs per key (a user's settings span every node).
 */
export type InheritedMtu = { mtu: number | null; source: AwgSettingSource | "keys" | "levels" };

const OWN = "own";
const INHERIT = "inherit";

/** "from the server", "from the user", ... */
export const useAwgSourceLabel = () => {
  const { t } = useT();
  return (source: InheritedMtu["source"]) => t(`awgSettings.from.${source}`);
};

/**
 * The client MTU of one level: inherit (saying what and from where) or a
 * number of its own. Choosing "inherit" again is the one-click reset.
 */
export function MtuField({ id, value, inherited, disabled, onChange }: {
  id: string;
  /** This level's own MTU; null inherits. */
  value: number | null;
  inherited: InheritedMtu;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const { t } = useT();
  const sourceLabel = useAwgSourceLabel();
  const own = value !== null;
  return (
    <div className="grid gap-1.5">
      <Label htmlFor={id}>{t("generator.mtu")}</Label>
      <div className="flex flex-wrap items-center gap-2">
        <Select
          value={own ? OWN : INHERIT}
          disabled={disabled}
          onValueChange={(next) =>
            onChange(next === OWN ? (inherited.mtu ?? AWG_DEFAULT_CLIENT_MTU) : null)}
        >
          <SelectTrigger id={id} className="min-w-0 flex-1 sm:max-w-xs">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={INHERIT}>
              {inherited.mtu === null
                ? t("awgSettings.mtuInheritUnknown", { source: sourceLabel(inherited.source) })
                : t("awgSettings.mtuInherit", { mtu: inherited.mtu, source: sourceLabel(inherited.source) })}
            </SelectItem>
            <SelectItem value={OWN}>{t("awgSettings.mtuOwn")}</SelectItem>
          </SelectContent>
        </Select>
        {own ? (
          <Input
            aria-label={t("generator.mtu")}
            type="number"
            required
            min={1280}
            max={1420}
            className="w-28"
            disabled={disabled}
            value={Number.isNaN(value) ? "" : value}
            onChange={(event) => onChange(event.target.valueAsNumber)}
          />
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {own
          ? t("awgSettings.mtuOwnHint")
          : inherited.mtu === null
            ? t("awgSettings.mtuInheritHintUnknown", { source: sourceLabel(inherited.source) })
            : t("awgSettings.mtuInheritHint", { mtu: inherited.mtu, source: sourceLabel(inherited.source) })}
      </p>
    </div>
  );
}
