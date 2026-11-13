import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ApiError } from "./service.js";

/**
 * In-panel "Update" button, host-worker half.
 *
 * control-api runs inside docker compose and cannot restart the stack from
 * within (it would kill itself mid-request), so the button does NOT touch
 * docker. Instead it drops a request file into a spool directory that is
 * bind-mounted from the host; a host-side systemd path unit watches that file
 * and runs infra/prod/update.sh (backup → pull → migrate → up), then writes a
 * result file back. This module is the panel side: write the request, read the
 * status. See infra/prod/panel-updater.* for the host units.
 */

export type VersionInfo = {
  version: string;
  commit: string | null;
  builtAt: string | null;
  /** The repository this build came from; see `DEFAULT_REPOSITORY_URL`. */
  repositoryUrl?: string | null;
};

export type UpdateRequestFile = {
  id: string;
  requestedAt: string;
  requestedBy: string;
};

export type UpdateResultFile = {
  id: string;
  finishedAt: string;
  ok: boolean;
  message: string;
};

/** Written by the host worker the moment it takes a request (matched by id). */
export type UpdateStartedFile = {
  id: string;
  startedAt: string;
};

/**
 * Whether the host worker has taken the request:
 * - `pending`: queued, still inside the acknowledgement deadline
 * - `acknowledged`: the host started it, or its result is already there
 * - `unacknowledged`: queued past the deadline with no host-start and no result
 *   for that request id. Informational only: the request stays in the spool and
 *   is never re-queued or retried by the panel.
 */
export type UpdateAcknowledgement = "pending" | "acknowledged" | "unacknowledged";

/** Same code the bridge-agent update view uses for an overdue acknowledgement. */
export const UPDATE_NOT_ACKNOWLEDGED = "UPDATE_NOT_ACKNOWLEDGED";

/** Default acknowledgement deadline; mirrors the bridge-agent pickup window. */
export const UPDATE_ACKNOWLEDGEMENT_DEADLINE_SECONDS = 120;

export type UpdateStatus = {
  /**
   * Whether the button can work: the spool is configured AND writable by this
   * process. A spool docker created as root (install-updater.sh never ran)
   * reads as disabled, since no host worker would pick a request up.
   */
  enabled: boolean;
  version: VersionInfo;
  /** A request awaiting the host worker, or null. */
  pending: UpdateRequestFile | null;
  /** The most recent finished run reported by the host worker, or null. */
  lastResult: UpdateResultFile | null;
  /**
   * Additive (older clients ignore these). `acknowledgement` describes the
   * pending request, or the confirmed running one; null when neither exists.
   */
  acknowledgement: UpdateAcknowledgement | null;
  /** Seconds since the pending request was queued; null without one. */
  requestAgeSeconds: number | null;
  /** The deadline in force, so a client can show "x of y seconds". */
  acknowledgementDeadlineSeconds: number;
  /** `UPDATE_NOT_ACKNOWLEDGED` while a request is unacknowledged, else null. */
  diagnosticHint: typeof UPDATE_NOT_ACKNOWLEDGED | null;
  /** A host-started update with no result yet (the request file is consumed). */
  running: UpdateStartedFile | null;
};

export type UpdateRequestResult = {
  scheduled: boolean;
  alreadyPending: boolean;
  request: UpdateRequestFile;
};

export interface UpdateController {
  status(): Promise<UpdateStatus>;
  request(requestedBy: string): Promise<UpdateRequestResult>;
}

const REQUEST_FILE = "request.json";
const RESULT_FILE = "result.json";
const STARTED_FILE = "started.json";

const readJsonIfPresent = async <T>(path: string): Promise<T | null> => {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch (error) {
    // Missing file is the common, expected case; anything else (corrupt JSON,
    // permissions) is treated as "no data" so status never throws.
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    return null;
  }
};

const isWritableDir = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.W_OK | constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

const notConfigured = () =>
  new ApiError(
    501,
    "The update mechanism is not configured on this host",
    "UPDATE_NOT_CONFIGURED",
  );

/** Parses `UPDATE_ACK_DEADLINE_SECONDS`; anything not a positive number is the default. */
export const parseAcknowledgementDeadlineSeconds = (
  raw: string | undefined,
): number => {
  const value = Number(raw?.trim());
  return Number.isFinite(value) && value > 0
    ? value
    : UPDATE_ACKNOWLEDGEMENT_DEADLINE_SECONDS;
};

export function createUpdateController(options: {
  spoolDir?: string | null;
  version: VersionInfo;
  acknowledgementDeadlineSeconds?: number;
  now?: () => number;
}): UpdateController {
  const deadlineSeconds =
    options.acknowledgementDeadlineSeconds ??
    UPDATE_ACKNOWLEDGEMENT_DEADLINE_SECONDS;
  const now = options.now ?? Date.now;
  const spoolDir = options.spoolDir?.trim() || null;
  const requestPath = spoolDir ? join(spoolDir, REQUEST_FILE) : null;
  const resultPath = spoolDir ? join(spoolDir, RESULT_FILE) : null;

  const status = async (): Promise<UpdateStatus> => {
    if (
      !spoolDir ||
      !requestPath ||
      !resultPath ||
      !(await isWritableDir(spoolDir))
    ) {
      return {
        enabled: false,
        version: options.version,
        pending: null,
        lastResult: null,
        acknowledgement: null,
        requestAgeSeconds: null,
        acknowledgementDeadlineSeconds: deadlineSeconds,
        diagnosticHint: null,
        running: null,
      };
    }
    const [pending, lastResult, started] = await Promise.all([
      readJsonIfPresent<UpdateRequestFile>(requestPath),
      readJsonIfPresent<UpdateResultFile>(resultPath),
      readJsonIfPresent<UpdateStartedFile>(join(spoolDir, STARTED_FILE)),
    ]);
    // Records are matched by request id: a stale started/result file from an
    // earlier run never acknowledges a newer request.
    const startedId = typeof started?.id === "string" ? started.id : null;
    const running =
      startedId && startedId !== lastResult?.id && !pending
        ? { id: startedId, startedAt: String(started?.startedAt ?? "") }
        : null;
    let acknowledgement: UpdateAcknowledgement | null = running
      ? "acknowledged"
      : null;
    let requestAgeSeconds: number | null = null;
    if (pending) {
      const requestedMs = Date.parse(pending.requestedAt);
      requestAgeSeconds = Number.isFinite(requestedMs)
        ? Math.max(0, Math.floor((now() - requestedMs) / 1000))
        : null;
      if (startedId === pending.id || lastResult?.id === pending.id) {
        acknowledgement = "acknowledged";
      } else if (
        // An undatable request cannot be shown to be fresh: fail closed.
        requestAgeSeconds === null ||
        requestAgeSeconds >= deadlineSeconds
      ) {
        acknowledgement = "unacknowledged";
      } else {
        acknowledgement = "pending";
      }
    }
    return {
      enabled: true,
      version: options.version,
      pending,
      lastResult,
      acknowledgement,
      requestAgeSeconds,
      acknowledgementDeadlineSeconds: deadlineSeconds,
      diagnosticHint:
        acknowledgement === "unacknowledged" ? UPDATE_NOT_ACKNOWLEDGED : null,
      running,
    };
  };

  const request = async (requestedBy: string): Promise<UpdateRequestResult> => {
    if (!spoolDir || !requestPath || !(await isWritableDir(spoolDir))) {
      throw notConfigured();
    }
    const existing = await readJsonIfPresent<UpdateRequestFile>(requestPath);
    if (existing) {
      // Do not stack requests — the host worker will pick up the pending one.
      return { scheduled: false, alreadyPending: true, request: existing };
    }
    const payload: UpdateRequestFile = {
      id: randomUUID(),
      requestedAt: new Date().toISOString(),
      requestedBy,
    };
    // Write atomically (temp + rename) so the host path unit never sees a
    // half-written request file.
    const tmpPath = `${requestPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(tmpPath, requestPath);
    return { scheduled: true, alreadyPending: false, request: payload };
  };

  return { status, request };
}
