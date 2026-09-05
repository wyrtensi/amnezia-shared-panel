"use client";

import { cn } from "@/lib/utils";

/** One node's verdict for one service check, as `useServiceChecks` reports it. */
export type NodeCheckResult = {
  id: string;
  name: string;
  status: string;
  detail: string | null;
};

/**
 * The colour a verdict carries. `error` keeps its own tone rather than folding
 * into `failed`: the node could not look, which is not the same as looking and
 * being refused, and an operator chases those two down different paths. Both
 * still read as "not ok" at a glance, which is what a summary owes.
 */
const TONE: Record<string, string> = {
  ok: "border-success/40 bg-success/10 text-success",
  failed: "border-destructive/45 bg-destructive/10 text-destructive",
  error: "border-warning/45 bg-warning/12 text-warning",
};

const DOT: Record<string, string> = {
  ok: "bg-success",
  failed: "bg-destructive",
  error: "bg-warning",
};

/**
 * A node's service checks as one line of chips: the check's name and a dot for
 * its verdict, nothing else.
 *
 * This is the reading surface, not the control surface. The switches that turn
 * a check off for a node, and the failure detail behind it, live on the nodes
 * page; here the detail is the chip's tooltip so a red chip is still
 * explainable without leaving the page.
 */
export function NodeCheckChips({
  results,
  className,
}: {
  results: NodeCheckResult[];
  className?: string;
}) {
  return (
    <ul className={cn("flex flex-wrap gap-1", className)}>
      {results.map((result) => (
        <li key={result.id}>
          <span
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5 text-[11px] leading-tight",
              TONE[result.status] ?? "border-border text-muted-foreground",
            )}
            // The verdict word joins the name so the chip does not rely on
            // colour alone, and the detail explains a red one on hover.
            title={[result.status, result.detail].filter(Boolean).join(" — ")}
          >
            <span
              aria-hidden
              className={cn(
                "size-1.5 shrink-0 rounded-full",
                DOT[result.status] ?? "bg-muted-foreground",
              )}
            />
            <span className="truncate">{result.name}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}
