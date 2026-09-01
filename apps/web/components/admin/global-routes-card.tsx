"use client";

import * as React from "react";
import { ChevronDown } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Callout, FieldHint } from "@/components/ui/hint";
import { RouteListEditor } from "@/components/route-list-editor";
import { useAdminData, newGlobalRoutes } from "@/components/admin/admin-data";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";
import type { GlobalRouteProfile, GlobalRoutes } from "@amnezia/contracts";

type Profile = keyof GlobalRoutes;
type Section = keyof GlobalRouteProfile;

const PROFILES: Profile[] = ["ru_whitelist", "ru_blacklist"];
const SECTIONS: Section[] = ["add", "exclude"];

const PROFILE_LABEL: Record<Profile, string> = {
  ru_whitelist: "route.ru_whitelist",
  ru_blacklist: "route.ru_blacklist",
};
const SECTION_TITLE: Record<Section, string> = {
  add: "groutes.add",
  exclude: "groutes.exclude",
};
const SECTION_HINT: Record<Section, string> = {
  add: "groutes.addHint",
  exclude: "groutes.excludeHint",
};

const cloneRoutes = (routes: GlobalRoutes): GlobalRoutes => {
  const next = newGlobalRoutes();
  for (const profile of PROFILES) {
    for (const section of SECTIONS) {
      next[profile][section] = {
        cidrs: [...routes[profile][section].cidrs],
        domains: [...routes[profile][section].domains],
      };
    }
  }
  return next;
};

const countEntries = (routes: GlobalRoutes): number => {
  let total = 0;
  for (const profile of PROFILES) {
    for (const section of SECTIONS) {
      total +=
        routes[profile][section].cidrs.length +
        routes[profile][section].domains.length;
    }
  }
  return total;
};

/**
 * Admin-wide route overrides layered on every user's split-tunnel feed:
 * `add` entries are merged in, `exclude` entries are stripped out before the
 * user's own custom routes are applied. Saving replaces the whole payload.
 *
 * Rendered collapsed by default at the top of the routing page so the fetched
 * rule-version list underneath stays reachable without a long scroll.
 */
export function GlobalRoutesCard() {
  const { globalRoutes, loading, action } = useAdminData();
  const { t } = useT();
  const [form, setForm] = React.useState<GlobalRoutes>(newGlobalRoutes);
  const [busy, setBusy] = React.useState(false);
  const [open, setOpen] = React.useState(false);

  const baseline = React.useRef(JSON.stringify(newGlobalRoutes()));
  React.useEffect(() => {
    baseline.current = JSON.stringify(globalRoutes);
    setForm(cloneRoutes(globalRoutes));
  }, [globalRoutes]);
  const dirty = JSON.stringify(form) !== baseline.current;

  const setList = (
    profile: Profile,
    section: Section,
    kind: "cidrs" | "domains",
    next: string[],
  ) =>
    setForm((prev) => {
      const updated = cloneRoutes(prev);
      updated[profile][section][kind] = next;
      return updated;
    });

  const save = async () => {
    setBusy(true);
    await action("global-routes", "global", "update", form);
    setBusy(false);
  };

  return (
    <Card>
      <CardContent className="p-0">
        <button
          type="button"
          aria-expanded={open}
          aria-controls="global-routes-panel"
          onClick={() => setOpen((prev) => !prev)}
          className="flex w-full items-start gap-3 px-5 py-4 text-left transition-colors hover:bg-muted/40"
        >
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="font-semibold">{t("groutes.title")}</h2>
              <span className="text-sm text-muted-foreground">
                {t("groutes.count", { count: countEntries(form) })}
              </span>
              {dirty ? (
                <span className="text-xs text-warning">
                  {t("groutes.unsaved")}
                </span>
              ) : null}
            </div>
            <p className="text-xs leading-snug text-muted-foreground">
              {t("groutes.subtitle")}
            </p>
          </div>
          <span className="flex items-center gap-1.5 pt-0.5 text-xs text-muted-foreground">
            {open ? t("groutes.collapse") : t("groutes.expand")}
            <ChevronDown
              className={cn(
                "h-4 w-4 transition-transform",
                open && "rotate-180",
              )}
            />
          </span>
        </button>

        {open ? (
          <div id="global-routes-panel" className="space-y-4 border-t px-5 py-4">
            <Callout tone="info">{t("groutes.hint")}</Callout>

            {loading ? (
              <div className="space-y-2">
                {[0, 1, 2].map((index) => (
                  <Skeleton key={index} className="h-10 w-full" />
                ))}
              </div>
            ) : (
              <Tabs defaultValue="ru_whitelist">
                <TabsList>
                  {PROFILES.map((profile) => (
                    <TabsTrigger key={profile} value={profile}>
                      {t(PROFILE_LABEL[profile])}
                    </TabsTrigger>
                  ))}
                </TabsList>
                {PROFILES.map((profile) => (
                  <TabsContent
                    key={profile}
                    value={profile}
                    className="space-y-5"
                  >
                    {SECTIONS.map((section, index) => (
                      <React.Fragment key={section}>
                        {index > 0 ? <Separator /> : null}
                        <div className="space-y-3">
                          <div className="space-y-1">
                            <h3 className="text-sm font-semibold">
                              {t(SECTION_TITLE[section])}
                            </h3>
                            <FieldHint>{t(SECTION_HINT[section])}</FieldHint>
                          </div>
                          <RouteListEditor
                            kind="cidr"
                            entries={form[profile][section].cidrs}
                            onChange={(next) =>
                              setList(profile, section, "cidrs", next)
                            }
                          />
                          <RouteListEditor
                            kind="domain"
                            entries={form[profile][section].domains}
                            onChange={(next) =>
                              setList(profile, section, "domains", next)
                            }
                          />
                        </div>
                      </React.Fragment>
                    ))}
                  </TabsContent>
                ))}
              </Tabs>
            )}

            <div className="flex justify-end">
              <Button
                disabled={busy || loading || !dirty}
                onClick={() => void save()}
              >
                {busy ? t("common.saving") : t("groutes.save")}
              </Button>
            </div>
          </div>
        ) : null}
      </CardContent>
    </Card>
  );
}
