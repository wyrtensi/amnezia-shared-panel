"use client";

import * as React from "react";
import { toast } from "sonner";
import { Route } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Callout, Hint } from "@/components/ui/hint";
import {
  InactiveDomainList,
  RouteListEditor,
} from "@/components/route-list-editor";
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

/**
 * What the PUT body may contain: addresses. The form keeps whatever site names
 * the row arrived with so they can be shown, but they never go back to the API
 * — which refuses them anyway — so a save is also how they finally leave.
 */
const addressesOnly = (routes: CustomRoutes): CustomRoutes => ({
  ru_whitelist: { cidrs: routes.ru_whitelist.cidrs, domains: [] },
  ru_blacklist: { cidrs: routes.ru_blacklist.cidrs, domains: [] },
});

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
 *
 * Addresses only. Site names were accepted here once and never did anything —
 * an exported key routes on AllowedIPs — so the input is gone and any names a
 * row still holds are shown as inert by `InactiveDomainList`. Every save writes
 * an empty domain list, which is also what the API now insists on.
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

  const setCidrs = (next: string[]) =>
    setRoutes((prev) => {
      const updated = cloneRoutes(prev);
      updated[profile].cidrs = next;
      return updated;
    });
  // Both profiles at once, not just the one on screen: a save clears every
  // list, so showing only the selected tab's leftovers would quietly drop the
  // other tab's without the user ever having seen them.
  const staleDomains = [
    ...routes.ru_whitelist.domains,
    ...routes.ru_blacklist.domains,
  ];
  const clearDomains = () => setRoutes((prev) => addressesOnly(prev));

  const save = async () => {
    setSaving(true);
    try {
      const result = await apiRequest<{ customRoutes: CustomRoutes }>(
        "/api/me/custom-routes",
        { method: "PUT", body: JSON.stringify(addressesOnly(routes)) },
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

  // Counts what the profile actually routes. Stale site names are excluded on
  // purpose: they are listed as inactive right below, and counting them here
  // would claim they are doing something.
  const total =
    routes.ru_whitelist.cidrs.length + routes.ru_blacklist.cidrs.length;

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
          <div className="flex flex-wrap items-center gap-1.5">
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

        <RouteListEditor entries={list.cidrs} onChange={setCidrs} />
        <InactiveDomainList
          domains={staleDomains}
          onClear={clearDomains}
          disabled={saving}
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
