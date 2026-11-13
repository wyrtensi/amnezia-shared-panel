import Link from "next/link";
import { ArrowRight, Cable } from "lucide-react";
import type { AdminOverviewBridges } from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { nodesTabHref } from "@/lib/bridge-ui";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const STATUS_VARIANT = {
  ok: "success",
  pending_enrollment: "outline",
  down: "destructive",
  stale: "warning",
  identity_mismatch: "destructive",
  unsupported: "warning",
} as const;

/**
 * The compact Bridges block on the admin overview. It renders nothing unless
 * the API sent at least one bridge, so panels without bridges look unchanged.
 * Management reachability and the verified AWG path are separate facts: the
 * status badge is the first, the "verified" count is the second.
 */
export function OverviewBridgesBlock({
  bridges,
  t,
}: {
  bridges: AdminOverviewBridges | null | undefined;
  t: Translate;
}) {
  if (!bridges || bridges.items.length === 0) return null;
  return (
    <div className="space-y-3" data-testid="overview-bridges">
      <div className="flex items-center justify-between gap-2">
        <h2 className="flex items-center gap-2 font-semibold">
          <Cable className="h-4 w-4 text-chart-1" />
          {t("ov.bridgesTitle")}
          <span className="tabular text-sm font-normal text-muted-foreground">
            {bridges.count}
          </span>
        </h2>
        <Button asChild variant="ghost" size="sm">
          <Link href={nodesTabHref("bridges")} prefetch={false}>
            {t("ov.bridgesOpen")} <ArrowRight className="h-4 w-4" />
          </Link>
        </Button>
      </div>
      <div className="grid items-start gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {bridges.items.map((bridge) => (
          <Card key={bridge.id}>
            <CardContent className="space-y-1.5 p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="min-w-0 truncate font-medium leading-tight">{bridge.name}</p>
                <Badge variant={STATUS_VARIANT[bridge.managementStatus]}>
                  {t(`bridge.status.${bridge.managementStatus}`)}
                </Badge>
              </div>
              {bridge.activeRoutes === 0 ? (
                <p className="text-xs text-muted-foreground">{t("ov.bridgesNoActive")}</p>
              ) : (
                <div className="flex flex-wrap items-center gap-1.5 text-xs">
                  <span className="text-muted-foreground">
                    {t("ov.bridgesActive", { active: bridge.activeRoutes })}
                  </span>
                  {bridge.awgPathOk > 0 ? (
                    <Badge variant="success">{t("ov.bridgesAwgOk", { count: bridge.awgPathOk })}</Badge>
                  ) : null}
                  {bridge.awgPathFailed > 0 ? (
                    <Badge variant="destructive">
                      {t("ov.bridgesAwgFailed", { count: bridge.awgPathFailed })}
                    </Badge>
                  ) : null}
                  {bridge.awgPathUnknown > 0 ? (
                    <Badge variant="outline">
                      {t("ov.bridgesAwgUnknown", { count: bridge.awgPathUnknown })}
                    </Badge>
                  ) : null}
                </div>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
