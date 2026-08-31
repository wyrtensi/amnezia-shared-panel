import type { RulePayload } from "./vpnConfig.js";

export type RuleDiff = {
  cidrs: { added: string[]; removed: string[]; addedCount: number; removedCount: number };
  domains: {
    added: string[];
    removed: string[];
    addedCount: number;
    removedCount: number;
  };
};

const SAMPLE_LIMIT = 50;

const diffLists = (
  base: string[],
  next: string[],
): { added: string[]; removed: string[]; addedCount: number; removedCount: number } => {
  const baseSet = new Set(base);
  const nextSet = new Set(next);
  const added = next.filter((value) => !baseSet.has(value));
  const removed = base.filter((value) => !nextSet.has(value));
  return {
    added: added.slice(0, SAMPLE_LIMIT),
    removed: removed.slice(0, SAMPLE_LIMIT),
    addedCount: added.length,
    removedCount: removed.length,
  };
};

/**
 * Compare two rule payloads. `base` is the older version, `next` the newer one.
 * Sample lists are capped; the counts reflect the full difference.
 */
export const diffRulePayloads = (
  base: RulePayload,
  next: RulePayload,
): RuleDiff => ({
  cidrs: diffLists(base.cidrs ?? [], next.cidrs ?? []),
  domains: diffLists(base.domains ?? [], next.domains ?? []),
});
