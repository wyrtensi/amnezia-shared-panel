import type { KeyLimitMode } from "@/lib/types";

/** One server's usage against its own limit (per-node mode). */
export type NodeUsage = { nodeId: string; used: number; limit: number };
/** The whole account's usage against the pool (global mode). */
export type PoolUsage = { used: number; limit: number };

/**
 * The mode the control API enforces for a user: a valid per-user override in
 * `policyOverride.keyLimitMode`, else the global policy's mode, else per-node.
 * Mirrors `resolvePortalPolicy` on the server; used only for display.
 *
 * The override is `unknown` because it arrives from `policyOverride`, an
 * untyped JSON blob: an unrecognised value must fall back rather than throw.
 */
export const effectiveKeyLimitMode = (
  globalMode: KeyLimitMode | undefined,
  override: unknown,
): KeyLimitMode =>
  override === "global" || override === "per_node"
    ? override
    : (globalMode ?? "per_node");

/**
 * Whether the shared pool leaves no room. Always false in per-node mode, where
 * the pool numbers carry no meaning and must not disable anything.
 */
export const isPoolExhausted = (
  mode: KeyLimitMode,
  totals: PoolUsage,
): boolean => mode === "global" && totals.used >= totals.limit;

/** Whether one more key may go on this server, the way the API will decide. */
export const isNodeFull = (
  mode: KeyLimitMode,
  node: NodeUsage,
  totals: PoolUsage,
): boolean =>
  mode === "global" ? totals.used >= totals.limit : node.used >= node.limit;

/** Whether the "new key" button should be disabled. No server = nowhere to go. */
export const isAtLimit = (
  mode: KeyLimitMode,
  nodes: NodeUsage[],
  totals: PoolUsage,
): boolean =>
  nodes.length === 0 || nodes.every((node) => isNodeFull(mode, node, totals));
