import {
  normalizeWytunnelTransportConfig,
  type BridgeRouteVerification,
  type NodeBridgeRoute,
} from "@amnezia/contracts";
import { Badge } from "@/components/ui/badge";
import { BridgeRouteTransportStrip } from "@/components/admin/bridge-transport-dialog";
import { formatDateTime } from "@/lib/format";
import type { Lang } from "@/lib/i18n/messages";
import {
  bridgeEntry,
  DEFAULT_LOCAL_TARGET,
  registrationTone,
  verificationLabelKey,
  verificationTime,
  verificationTone,
} from "@/lib/bridge-ui";

type Translate = (key: string, vars?: Record<string, string | number>) => string;

const STATE_VARIANT = {
  active: "success",
  draft: "outline",
  retiring: "warning",
} as const;

export function BridgeDownloadBadge({
  verification,
  t,
}: {
  verification: BridgeRouteVerification;
  t: Translate;
}) {
  if (verification.kind !== "awg_path" || verification.downloadOk === undefined) return null;
  return (
    <Badge variant={verification.downloadOk ? "success" : "warning"}>
      {t("reachability.download")}: {t(verification.downloadOk ? "reachability.level.ok" : "reachability.level.fail")}
    </Badge>
  );
}

/**
 * The facts about one route the operator needs while preparing it: public
 * entry, local target, what the bridge last reported and the verification.
 * Presentational so it renders with any translator.
 */
export function BridgeRouteFacts({
  route,
  t,
  lang,
}: {
  route: NodeBridgeRoute;
  t: Translate;
  lang: Lang;
}) {
  // Registration and verification are computed by the API (one definition for
  // every screen); this view only labels them.
  const observation = route.registration;
  const verification = route.verification;
  const evidenceAt = verificationTime(verification);
  const when = (iso: string | null) =>
    iso ? formatDateTime(iso, lang) : t("bridge.unknown");

  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{route.bridgeName}</span>
        <Badge variant={STATE_VARIANT[route.state]}>{t(`bridge.state.${route.state}`)}</Badge>
        <BridgeRouteTransportStrip
          transport={route.transport}
          transportPort={route.transportPort}
          transportConfig={route.transportConfig}
          telemetry={route.telemetry}
          t={t}
        />
      </div>
      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">
        <dt className="text-muted-foreground">{t("bridge.publicEntry")}</dt>
        <dd className="break-all font-mono">
          {bridgeEntry(route.bridgePublicIpv4, route.publicUdpPort)}/udp
        </dd>
        <dt className="text-muted-foreground">{t("bridge.localTarget")}</dt>
        <dd className="break-all font-mono">{DEFAULT_LOCAL_TARGET}</dd>
        {route.transport === "wytunnel" ? (
          <>
            <dt className="text-muted-foreground">{t("bridge.transport.label")}</dt>
            <dd className="font-mono">
              {(() => {
                const cfg = normalizeWytunnelTransportConfig(route.transportConfig);
                const rot =
                  cfg.poolSize > 0 && cfg.poolRotateIntervalSec > 0
                    ? ` · rot ${Math.round(cfg.poolRotateIntervalSec / 60)}m`
                    : "";
                const fec = cfg.fec ? ` · FEC ${cfg.fec.k}:${cfg.fec.m}` : "";
                return `WyTunnel :${route.transportPort ?? "auto"} · ${
                  cfg.poolSize > 0 ? `pool ${cfg.poolSize}` : "direct"
                }${rot}${fec}`;
              })()}
            </dd>
            {route.telemetry ? (
              <>
                <dt className="text-muted-foreground">{t("bridge.wytunnel.tunnels")}</dt>
                <dd className="flex flex-wrap gap-x-3 gap-y-0.5 font-mono">
                  {route.telemetry.targetStreams !== undefined ? (
                    <span>
                      {route.telemetry.healthyStreams ?? 0}/{route.telemetry.targetStreams}
                    </span>
                  ) : null}
                  {route.telemetry.poolRttMs != null ? (
                    <span>
                      {t("bridge.wytunnel.rtt")}: {Math.round(route.telemetry.poolRttMs)} ms
                    </span>
                  ) : null}
                  {route.telemetry.activeSessions !== undefined ? (
                    <span>
                      {t("bridge.wytunnel.sessions")}: {route.telemetry.activeSessions}
                    </span>
                  ) : null}
                  {route.telemetry.rotationsTotal !== undefined ? (
                    <span>
                      {t("bridge.wytunnel.rotations")}: {route.telemetry.rotationsTotal}
                    </span>
                  ) : null}
                  {route.telemetry.failoversTotal !== undefined ? (
                    <span>
                      {t("bridge.wytunnel.failovers")}: {route.telemetry.failoversTotal}
                    </span>
                  ) : null}
                </dd>
              </>
            ) : null}
          </>
        ) : null}
        <dt className="text-muted-foreground">{t("bridge.registration")}</dt>
        <dd className="flex flex-wrap items-center gap-1.5">
          <Badge variant={registrationTone(observation.status)}>
            {t(`bridge.obs.${observation.status}`)}
          </Badge>
        </dd>
        <dt className="text-muted-foreground">{t("bridge.marker")}</dt>
        <dd className="break-all font-mono">
          {observation.marker ?? t("bridge.unknown")}
        </dd>
        <dt className="text-muted-foreground">{t("bridge.observedAt")}</dt>
        <dd>{when(observation.observedAt)}</dd>
        <dt className="text-muted-foreground">{t("bridge.verification")}</dt>
        <dd className="space-y-0.5">
          <Badge variant={verificationTone(verification)}>
            {t(verificationLabelKey(verification))}
          </Badge>
          <BridgeDownloadBadge verification={verification} t={t} />
          {evidenceAt ? (
            <span className="ml-1.5 text-muted-foreground">
              {when(evidenceAt)}
              {verification.kind === "candidate" && verification.method
                ? ` · ${t(`bridge.method.${verification.method}`)}`
                : ""}
            </span>
          ) : null}
          {verification.kind === "candidate" &&
          verification.status === "failed" &&
          verification.error ? (
            <span className="block font-mono text-destructive">{verification.error}</span>
          ) : null}
        </dd>
      </dl>
    </div>
  );
}
