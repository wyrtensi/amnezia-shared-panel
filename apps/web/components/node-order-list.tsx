"use client";

import { ChevronDown, ChevronUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/lib/i18n/provider";
import {
  materializeNodeOrder,
  moveNodeInOrder,
  recommendedCountFromIds,
  recommendedPrefix,
} from "@/lib/node-order";

/**
 * Hand-made server order, with the "recommended" prefix on top.
 *
 * Up/down buttons instead of drag-and-drop: no extra dependency, and
 * keyboard/screen-reader accessible for free. The recommended set is edited as
 * a COUNT from the top, because the API only accepts a prefix — ticking a row
 * recommends everything above it as well, unticking it drops everything below.
 * Every interaction emits the FULL explicit order together with the resolved
 * recommended ids, so what the admin sees is what users get and the payload can
 * never violate the prefix rule.
 */
export function NodeOrderList({
  nodes,
  order,
  recommended,
  onChange,
}: {
  nodes: Array<{ id: string; name: string }>;
  order: string[];
  recommended: string[];
  onChange: (next: {
    nodeOrder: string[];
    recommendedNodeIds: string[];
  }) => void;
}) {
  const { t } = useT();
  const ordered = materializeNodeOrder(nodes, order);
  const count = recommendedCountFromIds(ordered, recommended);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const emit = (nextOrder: string[], nextCount: number) =>
    onChange({
      nodeOrder: nextOrder,
      recommendedNodeIds: recommendedPrefix(nextOrder, nextCount),
    });
  if (nodes.length === 0) {
    return (
      <p className="text-xs text-muted-foreground">{t("nodeSelect.noNodes")}</p>
    );
  }
  return (
    <div className="space-y-2">
      <p className="text-xs text-muted-foreground">
        {t("policy.recommendedSummary", { count, total: ordered.length })}
      </p>
      <ol className="space-y-1.5">
        {ordered.map((id, index) => {
          const node = byId.get(id);
          if (!node) return null;
          const isRecommended = index < count;
          return (
            <li
              key={id}
              className={
                isRecommended
                  ? "flex items-center gap-2 rounded-lg border border-primary bg-primary/10 p-2 text-sm"
                  : "flex items-center gap-2 rounded-lg border p-2 text-sm"
              }
            >
              <span className="w-6 shrink-0 text-xs text-muted-foreground">
                {index + 1}
              </span>
              <Checkbox
                checked={isRecommended}
                aria-label={`${t("policy.recommendToggle")}: ${node.name}`}
                // Ticking row i recommends the first i+1 rows; unticking it
                // leaves the first i. Both stay a prefix by construction.
                onChange={(event) =>
                  emit(ordered, event.target.checked ? index + 1 : index)
                }
              />
              <span className="min-w-0 flex-1 truncate">{node.name}</span>
              {isRecommended ? (
                <Badge variant="success" className="shrink-0">
                  {t("wizard.recommended")}
                </Badge>
              ) : null}
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${t("policy.moveUp")}: ${node.name}`}
                disabled={index === 0}
                // The count stays a count: moving a row across the boundary
                // changes WHICH servers are recommended, visibly, right away.
                onClick={() => emit(moveNodeInOrder(ordered, id, -1), count)}
              >
                <ChevronUp className="size-4" />
              </Button>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label={`${t("policy.moveDown")}: ${node.name}`}
                disabled={index === ordered.length - 1}
                onClick={() => emit(moveNodeInOrder(ordered, id, 1), count)}
              >
                <ChevronDown className="size-4" />
              </Button>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
