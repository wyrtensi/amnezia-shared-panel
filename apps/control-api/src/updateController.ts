import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
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

export type UpdateStatus = {
  /** Whether the spool directory is configured (feature available). */
  enabled: boolean;
  version: VersionInfo;
  /** A request awaiting the host worker, or null. */
  pending: UpdateRequestFile | null;
  /** The most recent finished run reported by the host worker, or null. */
  lastResult: UpdateResultFile | null;
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

export function createUpdateController(options: {
  spoolDir?: string | null;
  version: VersionInfo;
}): UpdateController {
  const spoolDir = options.spoolDir?.trim() || null;
  const requestPath = spoolDir ? join(spoolDir, REQUEST_FILE) : null;
  const resultPath = spoolDir ? join(spoolDir, RESULT_FILE) : null;

  const status = async (): Promise<UpdateStatus> => {
    if (!spoolDir || !requestPath || !resultPath) {
      return {
        enabled: false,
        version: options.version,
        pending: null,
        lastResult: null,
      };
    }
    const [pending, lastResult] = await Promise.all([
      readJsonIfPresent<UpdateRequestFile>(requestPath),
      readJsonIfPresent<UpdateResultFile>(resultPath),
    ]);
    return { enabled: true, version: options.version, pending, lastResult };
  };

  const request = async (requestedBy: string): Promise<UpdateRequestResult> => {
    if (!spoolDir || !requestPath) {
      throw new ApiError(
        501,
        "The update mechanism is not configured on this host",
        "UPDATE_NOT_CONFIGURED",
      );
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
    await mkdir(spoolDir, { recursive: true });
    // Write atomically (temp + rename) so the host path unit never sees a
    // half-written request file.
    const tmpPath = `${requestPath}.tmp`;
    await writeFile(tmpPath, `${JSON.stringify(payload)}\n`, "utf8");
    await rename(tmpPath, requestPath);
    return { scheduled: true, alreadyPending: false, request: payload };
  };

  return { status, request };
}
