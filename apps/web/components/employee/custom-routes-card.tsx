"use client";

import * as React from "react";
import { toast } from "sonner";
import { Plus, Route, X } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Callout, Hint } from "@/components/ui/hint";
import { apiRequest } from "@/lib/api";
import { useT } from "@/lib/i18n/provider";
import {
  EMPTY_CUSTOM_ROUTES,
  type CustomRoutes,
  type Me,
} from "@/lib/types";

type Profile = "ru_whitelist" | "ru_blacklist";
const PROFILES: Profile[] = ["ru_whitelist", "ru_blacklist"];
const PROFILE_LABEL: Record<Profile, string> = {
  ru_whitelist: "route.ru_whitelist",
  ru_blacklist: "route.ru_blacklist",
};

// Light client-side checks; the control API is authoritative on save.
const looksLikeCidr = (value: string): boolean =>
  /^[0-9a-f.:]+(\/\d{1,3})?$/i.test(value) && /[.:]/.test(value);
const looksLikeDomain = (value: string): boolean =>
  /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/.test(
    value,
  );

const cloneRoutes = (routes: CustomRoutes): CustomRoutes => ({
  ru_whitelist: {
    cidrs: [...routes.ru_whitelist.cidrs],
    domains: [...routes.ru_whitelist.domains],
  },
  ru_blacklist: {
    cidrs: [...routes.ru_blacklist.cidrs],
    domains: [...routes.ru_blacklist.domains],
  },
});

/**
 * Self-service editor for a user's own extra routes. Entries are layered on top
 * of the chosen split-tunnel profile's base feed at export time; the base feed
 * itself is never shown here.
 */
export function CustomRoutesCard({
  me,
  onSaved,
}: {
  me: Me;
  onSaved?: () => void | Promise<void>;
}) {
  const { t } = useT();
  const [routes, setRoutes] = React.useState<CustomRoutes>(() =>
    cloneRoutes(me.customRoutes ?? EMPTY_CUSTOM_ROUTES),
  );
  const [profile, setProfile] = React.useState<Profile>("ru_whitelist");
  const [cidrInput, setCidrInput] = React.useState("");
  const [domainInput, setDomainInput] = React.useState("");
  const [saving, setSaving] = React.useState(false);

  const baseline = React.useRef(
    JSON.stringify(me.customRoutes ?? EMPTY_CUSTOM_ROUTES),
  );
  React.useEffect(() => {
    const next = me.customRoutes ?? EMPTY_CUSTOM_ROUTES;
    baseline.current = JSON.stringify(next);
    setRoutes(cloneRoutes(next));
  }, [me]);
  const dirty = JSON.stringify(routes) !== baseline.current;

  const list = routes[profile];

  const addCidr = () => {
    const value = cidrInput.trim().toLowerCase();
    if (!value) return;
    if (!looksLikeCidr(value)) {
      toast.error(t("routes.badIp"));
      return;
    }
    setCidrInput("");
    if (list.cidrs.includes(value)) return;
    setRoutes((prev) => {
      const next = cloneRoutes(prev);
      next[profile].cidrs.push(value);
      return next;
    });
  };

  const addDomain = () => {
    const value = domainInput.trim().toLowerCase();
    if (!value) return;
    if (!looksLikeDomain(value)) {
      toast.error(t("routes.badDomain"));
      return;
    }
    setDomainInput("");
    if (list.domains.includes(value)) return;
    setRoutes((prev) => {
      const next = cloneRoutes(prev);
      next[profile].domains.push(value);
      return next;
    });
  };

  const removeCidr = (value: string) =>
    setRoutes((prev) => {
      const next = cloneRoutes(prev);
      next[profile].cidrs = next[profile].cidrs.filter((x) => x !== value);
      return next;
    });
  const removeDomain = (value: string) =>
    setRoutes((prev) => {
      const next = cloneRoutes(prev);
      next[profile].domains = next[profile].domains.filter((x) => x !== value);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const result = await apiRequest<{ customRoutes: CustomRoutes }>(
        "/api/me/custom-routes",
        { method: "PUT", body: JSON.stringify(routes) },
      );
      baseline.current = JSON.stringify(result.customRoutes);
      setRoutes(cloneRoutes(result.customRoutes));
      toast.success(t("routes.saved"));
      void onSaved?.();
    } catch (cause) {
      toast.error(
        cause instanceof Error ? cause.message : t("routes.saveFailed"),
      );
    } finally {
      setSaving(false);
    }
  };

  const total =
    routes.ru_whitelist.cidrs.length +
    routes.ru_whitelist.domains.length +
    routes.ru_blacklist.cidrs.length +
    routes.ru_blacklist.domains.length;

  return (
    <Card>
      <CardContent className="flex flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-primary/10 text-primary">
            <Route className="h-5 w-5" />
          </div>
          <div>
            <p className="text-sm font-semibold">{t("routes.title")}</p>
            <p className="text-xs text-muted-foreground">
              {t("routes.subtitle")}
            </p>
          </div>
          <span className="ml-auto text-xs tabular-nums text-muted-foreground">
            {t("routes.count", { count: total })}
          </span>
        </div>

        <Callout tone="info">{t("routes.hint")}</Callout>

        <div className="space-y-2">
          <div className="flex items-center gap-1.5">
            {PROFILES.map((item) => (
              <Button
                key={item}
                type="button"
                size="sm"
                variant={profile === item ? "default" : "outline"}
                onClick={() => setProfile(item)}
              >
                {t(PROFILE_LABEL[item])}
              </Button>
            ))}
            <Hint side="top">{t("routes.profileHint")}</Hint>
          </div>
          <p className="text-xs leading-snug text-muted-foreground">
            {t(profile === "ru_whitelist" ? "routes.wl.desc" : "routes.bl.desc")}
          </p>
        </div>

        <RouteEditor
          label={t("routes.ipLabel")}
          placeholder={t("routes.ipPlaceholder")}
          value={cidrInput}
          onChange={setCidrInput}
          onAdd={addCidr}
          entries={list.cidrs}
          onRemove={removeCidr}
        />
        <RouteEditor
          label={t("routes.domainLabel")}
          placeholder={t("routes.domainPlaceholder")}
          value={domainInput}
          onChange={setDomainInput}
          onAdd={addDomain}
          entries={list.domains}
          onRemove={removeDomain}
        />

        <div className="flex justify-end">
          <Button size="sm" onClick={() => void save()} disabled={!dirty || saving}>
            {saving ? t("routes.saving") : t("routes.save")}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}

function RouteEditor({
  label,
  placeholder,
  value,
  onChange,
  onAdd,
  entries,
  onRemove,
}: {
  label: string;
  placeholder: string;
  value: string;
  onChange: (next: string) => void;
  onAdd: () => void;
  entries: string[];
  onRemove: (value: string) => void;
}) {
  return (
    <div className="space-y-2">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex gap-2">
        <Input
          value={value}
          placeholder={placeholder}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              onAdd();
            }
          }}
        />
        <Button type="button" size="icon" variant="outline" onClick={onAdd}>
          <Plus className="h-4 w-4" />
        </Button>
      </div>
      {entries.length > 0 ? (
        <div className="flex flex-wrap gap-1.5">
          {entries.map((entry) => (
            <span
              key={entry}
              className="inline-flex items-center gap-1 rounded-md bg-muted px-2 py-0.5 font-mono text-xs"
            >
              {entry}
              <button
                type="button"
                onClick={() => onRemove(entry)}
                className="text-muted-foreground transition-colors hover:text-destructive"
                aria-label={`Remove ${entry}`}
              >
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}
