"use client";

import * as React from "react";
import { RefreshCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useAdminData } from "@/components/admin/admin-data";
import { readRulesRefreshState } from "@/lib/rules-refresh";
import { cn } from "@/lib/utils";
import { useT } from "@/lib/i18n/provider";

/** How often the refresh job status is polled, and for how long. */
const POLL_MS = 2000;
const MAX_POLLS = 45;
/**
 * Polls tolerated before giving up on the status read. When the backend does
 * not expose the refresh state, the job still ran — so instead of reporting a
 * failure the UI waits this long, reloads and reports what actually changed.
 */
const MAX_UNKNOWN_POLLS = 3;

type Phase =
  | "idle"
  | "queued"
  | "running"
  | "unchanged"
  | "updated"
  | "failed"
  | "timeout";

/**
 * Manual "check for updates" for the RoscomVPN feeds: enqueues the worker job
 * and follows it to a real outcome. A check that finds no new version is a
 * success ("checked, nothing new"), never a failure.
 */
export function RulesRefreshButton() {
  const { rules, reload, action, request } = useAdminData();
  const { t } = useT();
  const [phase, setPhase] = React.useState<Phase>("idle");
  const [error, setError] = React.useState<string | null>(null);
  /** Rule version ids known before the check, to tell "new version" from "no change". */
  const knownIds = React.useRef<Set<string>>(new Set());
  /**
   * `completedAt` of the previous run. The status row survives a completed run,
   * so a "completed" carrying this same timestamp is the old result, not ours.
   */
  const previousCompletedAt = React.useRef<string | null>(null);
  /** Set once the job is done and the list has been reloaded. */
  const [compare, setCompare] = React.useState(false);

  const polling = phase === "queued" || phase === "running";

  const start = async () => {
    knownIds.current = new Set(rules.map((rule) => rule.id));
    previousCompletedAt.current =
      (await readRulesRefreshState(request))?.completedAt ?? null;
    setError(null);
    setCompare(false);
    setPhase("queued");
    // The trigger goes through the generic admin action route:
    // POST /api/admin/rules/global/refresh
    const accepted = await action("rules", "global", "refresh");
    if (!accepted) {
      // `action` already surfaced the reason as a toast.
      setPhase("failed");
    }
  };

  React.useEffect(() => {
    if (!polling) return;
    let cancelled = false;
    let done = false;
    let polls = 0;
    let unknownPolls = 0;

    const finish = async () => {
      done = true;
      await reload();
      if (cancelled) return;
      setCompare(true);
    };

    const tick = async () => {
      if (done) return;
      polls += 1;
      const state = await readRulesRefreshState(request);
      if (cancelled) return;
      if (!state) {
        unknownPolls += 1;
        if (unknownPolls >= MAX_UNKNOWN_POLLS) await finish();
        else if (polls >= MAX_POLLS) setPhase("timeout");
        return;
      }
      unknownPolls = 0;
      if (state.phase === "failed") {
        setError(state.lastError);
        setPhase("failed");
        return;
      }
      if (
        state.phase === "succeeded" &&
        state.completedAt !== previousCompletedAt.current
      ) {
        await finish();
        return;
      }
      if (state.phase === "running") setPhase("running");
      if (polls >= MAX_POLLS) setPhase("timeout");
    };

    const timer = setInterval(() => void tick(), POLL_MS);
    void tick();
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [polling, reload, request]);

  // The reload above has already landed, so `rules` here is the fresh list.
  React.useEffect(() => {
    if (!compare) return;
    const appeared = rules.some((rule) => !knownIds.current.has(rule.id));
    setCompare(false);
    setPhase(appeared ? "updated" : "unchanged");
  }, [compare, rules]);

  const label =
    phase === "queued"
      ? t("rules.refreshQueued")
      : phase === "running"
        ? t("rules.refreshRunning")
        : t("rules.refresh");

  const message =
    phase === "unchanged"
      ? { text: t("rules.refreshUnchanged"), tone: "text-success" }
      : phase === "updated"
        ? { text: t("rules.refreshUpdated"), tone: "text-success" }
        : phase === "timeout"
          ? { text: t("rules.refreshTimeout"), tone: "text-warning" }
          : phase === "failed"
            ? {
                text: error
                  ? t("rules.refreshFailedWith", { error })
                  : t("rules.refreshFailed"),
                tone: "text-destructive",
              }
            : null;

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {message ? (
        <span className={cn("text-xs", message.tone)} role="status">
          {message.text}
        </span>
      ) : null}
      <Button
        size="sm"
        variant="secondary"
        disabled={polling}
        onClick={() => void start()}
      >
        <RefreshCw className={cn("h-4 w-4", polling && "animate-spin")} />
        {label}
      </Button>
    </div>
  );
}
