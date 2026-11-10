import {
  CONFIG_REFRESH_STALE,
  CONFIG_REFRESH_UNAVAILABLE,
  type ConfigRefreshResult,
  type ConfigRefreshStatus,
} from "@amnezia/contracts";

import { ApiClientError } from "./api";

export type ConfigRefreshOutcome =
  /** A new revision is saved; deliver the config. */
  | { kind: "refreshed"; revision: number }
  /** This key's config cannot take a profile (2.0, not active). */
  | { kind: "unavailable" }
  /** Nothing was saved, or it is not known that anything was. */
  | { kind: "retry" };

type Request = <T>(path: string, init?: RequestInit) => Promise<T>;

const refreshPath = (keyId: string) =>
  `/api/keys/${encodeURIComponent(keyId)}/config-refresh`;

/**
 * "Refresh config", as one call: check, then commit with the token the check
 * gave. Never commits twice. When the commit's answer is a stale token or is
 * lost, it checks again: a revision past the one it saw means the refresh is
 * already in (another tab, or this very request), so the current config is
 * delivered without another mutation. Otherwise the next try is the user's.
 */
export const refreshKeyConfig = async (
  keyId: string,
  request: Request,
): Promise<ConfigRefreshOutcome> => {
  const path = refreshPath(keyId);
  const status = await request<ConfigRefreshStatus>(path);
  if (!status.eligible) return { kind: "unavailable" };
  try {
    const result = await request<ConfigRefreshResult>(path, {
      method: "POST",
      body: JSON.stringify({ refreshToken: status.refreshToken }),
    });
    return { kind: "refreshed", revision: result.revision };
  } catch (error) {
    if (error instanceof ApiClientError) {
      if (error.code === CONFIG_REFRESH_UNAVAILABLE) return { kind: "unavailable" };
      // A definite refusal (403, 404, a bad request) is the answer as it is.
      if (error.code !== CONFIG_REFRESH_STALE && error.status < 500) throw error;
    }
    let again: ConfigRefreshStatus;
    try {
      again = await request<ConfigRefreshStatus>(path);
    } catch {
      return { kind: "retry" };
    }
    return again.eligible && again.revision > status.revision
      ? { kind: "refreshed", revision: again.revision }
      : { kind: "retry" };
  }
};
