import * as React from "react";
import { clockDayTime } from "@amnezia/contracts";

import type { UserNodeReachability } from "@/lib/types";

/**
 * When a block began, as "12.11 10:11" in `timeZone` - the browser's own zone
 * when none is given, which is how the cabinet shows it. The same format as
 * the Telegram widget, which keeps the probe's configured zone instead.
 */
export const formatSince = (since: string, timeZone?: string): string =>
  clockDayTime(new Date(since), timeZone);

const subscribeNever = () => () => undefined;

/**
 * False on the server and during hydration, true afterwards. A clock time in
 * the browser's zone cannot be rendered on the server (it does not know the
 * zone), so anything zone-dependent waits for this instead of mismatching.
 */
export const useHydrated = (): boolean =>
  React.useSyncExternalStore(
    subscribeNever,
    () => true,
    () => false,
  );

/**
 * What the key card's status badge shows: the key's own state, except that an
 * active key on a server the probe finds blocked reads "blocked". Every other
 * state (provisioning, failed, disabled, ...) is about the key itself and
 * wins; an `unknown` verdict changes nothing.
 */
export const keyBadgeState = (
  keyState: string,
  nodeReachability: UserNodeReachability | undefined,
): string =>
  keyState === "active" && nodeReachability?.state === "blocked" ? "blocked" : keyState;

/**
 * Blocked servers first, everything else in the order the API sent (the
 * admin's order). Stable, and never reorders within either group.
 */
export const blockedFirst = <T extends { reachability?: UserNodeReachability }>(
  nodes: readonly T[],
): T[] => [
  ...nodes.filter((node) => node.reachability?.state === "blocked"),
  ...nodes.filter((node) => node.reachability?.state !== "blocked"),
];
