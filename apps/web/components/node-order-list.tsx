"use client";

import * as React from "react";
import { ChevronDown, ChevronUp, GripVertical } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useT } from "@/lib/i18n/provider";
import {
  materializeNodeOrder,
  moveNodeInOrder,
  moveNodeToIndex,
  recommendedCountFromIds,
  recommendedPrefix,
  recommendNode,
  unrecommendNode,
} from "@/lib/node-order";

/**
 * Hand-made server order, with the "recommended" prefix on top.
 *
 * Rows are dragged with the native HTML5 drag-and-drop API — no dependency,
 * and `apps/web` has no dnd library. The up/down buttons stay: HTML5 dragging
 * has no keyboard story at all and is unreliable under touch, so the buttons
 * are the accessible path, not a leftover.
 *
 * The API only accepts a recommended set that is a PREFIX of the order, so the
 * tick cannot recommend a row where it stands. It moves the row instead:
 * ticking raises it to the bottom of the recommended block, unticking drops it
 * just below the shrunken block. Every other row keeps the recommendation it
 * had. Every interaction emits the FULL explicit order together with the
 * resolved recommended ids, so what the admin sees is what users get and the
 * payload can never violate the prefix rule.
 */
export function NodeOrderList({
  nodes,
  order,
  recommended,
  onChange,
}: {
  nodes: Array<{
    id: string;
    name: string;
    address?: string | null;
    enabled?: boolean;
  }>;
  order: string[];
  recommended: string[];
  onChange: (next: {
    nodeOrder: string[];
    recommendedNodeIds: string[];
  }) => void;
}) {
  const { t } = useT();
  const [dragging, setDragging] = React.useState<string | null>(null);
  const [over, setOver] = React.useState<string | null>(null);
  const ordered = materializeNodeOrder(nodes, order);
  const count = recommendedCountFromIds(ordered, recommended);
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const emit = (nextOrder: string[], nextCount: number) =>
    onChange({
      nodeOrder: nextOrder,
      recommendedNodeIds: recommendedPrefix(nextOrder, nextCount),
    });
  const endDrag = () => {
    setDragging(null);
    setOver(null);
  };
  const dropOn = (targetId: string) => {
    // Read the id from state rather than the drop event: Safari hands back an
    // empty dataTransfer on some drops, and the source row is ours either way.
    if (dragging && dragging !== targetId) {
      emit(moveNodeToIndex(ordered, dragging, ordered.indexOf(targetId)), count);
    }
    endDrag();
  };
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
      {/* The recess belongs to the list, not to each row: with a well under
          every item the rows stopped reading as one ordered sequence and became
          three separate controls. */}
      <ol className="space-y-1.5 rounded-lg border border-border/60 bg-well p-1.5 shadow-[var(--inset-shadow)]">
        {ordered.map((id, index) => {
          const node = byId.get(id);
          if (!node) return null;
          const isRecommended = index < count;
          const rowStyle = [
            // The rows sit ON the list's recess, so they take the card colour
            // rather than being transparent over it. Wrap trailing controls
            // onto a second line on narrow phones so the label stays readable.
            "flex flex-wrap items-center justify-between gap-2 rounded-lg border bg-card p-2 text-sm transition-colors sm:flex-nowrap",
            isRecommended ? "border-primary bg-primary/10" : "",
            over === id && dragging !== id ? "border-dashed border-primary" : "",
            dragging === id ? "opacity-50" : "",
          ]
            .filter(Boolean)
            .join(" ");
          return (
            <li
              key={id}
              className={rowStyle}
              draggable
              onDragStart={(event) => {
                setDragging(id);
                // Firefox starts no drag at all without data on the transfer.
                event.dataTransfer.setData("text/plain", id);
                event.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(event) => {
                // Without preventDefault the browser refuses the drop.
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
                if (over !== id) setOver(id);
              }}
              onDrop={(event) => {
                event.preventDefault();
                dropOn(id);
              }}
              onDragEnd={endDrag}
            >
              <div className="flex min-w-0 flex-1 items-center gap-2">
                <span
                  className="shrink-0 cursor-grab text-muted-foreground active:cursor-grabbing"
                  aria-hidden="true"
                >
                  <GripVertical className="size-4" />
                </span>
                <span className="w-5 shrink-0 text-xs text-muted-foreground">
                  {index + 1}
                </span>
                <Checkbox
                  checked={isRecommended}
                  className="shrink-0"
                  aria-label={`${t("policy.recommendToggle")}: ${node.name}`}
                  // The row moves, the other rows keep their state: ticking
                  // raises this one into the recommended block, unticking drops
                  // it just under it. Both stay a prefix by construction.
                  onChange={(event) =>
                    onChange(
                      event.target.checked
                        ? recommendNode(ordered, count, id)
                        : unrecommendNode(ordered, count, id),
                    )
                  }
                />
                <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                  <span className="truncate font-medium">{node.name}</span>
                  {node.address ? (
                    <code className="break-all font-mono text-xs text-muted-foreground">
                      {node.address}
                    </code>
                  ) : null}
                  {node.enabled === false ? (
                    <span className="text-xs text-muted-foreground">
                      ({t("nodes.endpointDisabled").toLowerCase()})
                    </span>
                  ) : null}
                </div>
              </div>
              <div className="flex w-full shrink-0 items-center justify-end gap-1.5 sm:w-auto">
                {isRecommended ? (
                  <Badge variant="success" className="mr-auto shrink-0 sm:mr-0">
                    {t("wizard.recommended")}
                  </Badge>
                ) : null}
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="size-8 shrink-0"
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
                  className="size-8 shrink-0"
                  aria-label={`${t("policy.moveDown")}: ${node.name}`}
                  disabled={index === ordered.length - 1}
                  onClick={() => emit(moveNodeInOrder(ordered, id, 1), count)}
                >
                  <ChevronDown className="size-4" />
                </Button>
              </div>
            </li>
          );
        })}
      </ol>
      <p className="text-xs text-muted-foreground">{t("policy.dragHint")}</p>
    </div>
  );
}
