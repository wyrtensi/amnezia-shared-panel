import type { NodeBridgeRoute } from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { formatDateTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n/messages";
import {
  bridgeEntry,
  DEFAULT_LOCAL_TARGET,
  routeObservation,
  routeVerification,
} from "@/lib/bridge-ui";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const STATE_VARIANT = {
  active: "success",
  draft: "outline",
  retiring: "warning",
} as const;

const OBSERVATION_VARIANT = {
  online: "success",
  offline: "destructive",
  unknown: "outline",
} as const;

/**
 * The facts about one route the operator needs while preparing it: public
 * entry, local target, what the bridge last reported and the verification.
 * Presentational so it renders with any translator.
 */
export function BridgeRouteFacts({
  route,
  t,
  lang,
  now,
}: {
  route: NodeBridgeRoute;
  t: Translate;
  lang: Lang;
  now: number;
}) {
  const observation = routeObservation(route, now);
  const verification = routeVerification(route, now);
  const when = (iso: string | null) =>
    iso ? formatDateTime(iso, lang) : t("bridge.unknown");

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{route.bridgeName}</span>
        <Badge variant={STATE_VARIANT[route.state]}>{t(`bridge.state.${route.state}`)}</Badge>
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("bridge.publicEntry")}</dt>
        <dd className="break-all font-mono">
          {bridgeEntry(route.bridgePublicIpv4, route.publicUdpPort)}/udp
        </dd>
        <dt className="text-muted-foreground">{t("bridge.localTarget")}</dt>
        <dd className="break-all font-mono">{DEFAULT_LOCAL_TARGET}</dd>
        <dt className="text-muted-foreground">{t("bridge.registration")}</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <Badge variant={OBSERVATION_VARIANT[observation.status]}>
            {t(`bridge.obs.${observation.status}`)}
          </Badge>
        </dd>
        <dt className="text-muted-foreground">{t("bridge.marker")}</dt>
        <dd className="break-all font-mono">
          {observation.marker ?? t("bridge.unknown")}
        </dd>
        <dt className="text-muted-foreground">{t("bridge.observedAt")}</dt>
        <dd>{when(route.observedAt)}</dd>
        <dt className="text-muted-foreground">{t("bridge.verification")}</dt>
        <dd className="space-y-0.5">
          <Badge
            variant={
              verification.status === "valid"
                ? "success"
                : verification.status === "failed"
                  ? "destructive"
                  : verification.status === "none"
                    ? "outline"
                    : "warning"
            }
          >
            {t(`bridge.ver.${verification.status}`)}
          </Badge>
          {verification.status !== "none" && verification.at ? (
            <span className="ml-1.5 text-muted-foreground">
              {when(verification.at)}
              {verification.method ? ` · ${t(`bridge.method.${verification.method}`)}` : ""}
            </span>
          ) : null}
          {verification.status === "failed" && verification.error ? (
            <span className="block font-mono text-destructive">{verification.error}</span>
          ) : null}
        </dd>
      </dl>
    </div>
  );
}
