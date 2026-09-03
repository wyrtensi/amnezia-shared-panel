import { randomUUID } from "crypto";
import { accessSync, constants } from "fs";
import fs from "fs/promises";
import path from "path";

import appConfig from "@/constants/appConfig";
import { appLogger } from "@/config/winstonLogger";
import { AgentUpdateStatus, AgentUpdateState } from "@/types/server";
import { isPublishableAgentImage } from "@/utils/agentImage";
import { APIError } from "@/utils/APIError";
import { ClientErrorCode, ServerErrorCode } from "@/types/shared";

/** The trigger the host-side path unit watches. Deleted by the updater. */
const REQUEST_FILE = "request.json";
/** The agent's own copy of the last request. The updater never touches it. */
const PENDING_FILE = "pending.json";
/** What the updater writes when it is done. */
const RESULT_FILE = "result.json";
const LOG_FILE = "update.log";

/** A failure's reason is on the last lines, so the tail is what is kept. */
const MAX_LOG_BYTES = 64 * 1024;

interface SpoolResult {
  id?: string;
  finishedAt?: string;
  ok?: boolean;
  image?: string;
  message?: string;
}

interface PendingRequest {
  id?: string;
  image?: string;
  requestedAt?: string;
}

/**
 * The agent's half of the update mechanism.
 *
 * This container mounts only the Docker socket: it cannot read compose.yaml,
 * cannot write .env - which is what the node's preflight validates - and has no
 * compose binary, so it cannot durably replace itself. It therefore only records
 * a request. infra/node/scripts/agent-update.sh, running on the host under
 * systemd, does the swap and writes the outcome back here.
 *
 * Everything about the state lives in the spool rather than in memory, because
 * the process answering a status call is usually not the process that made the
 * request - the update kills it.
 */
export class AgentUpdateService {
  static key = "agentUpdateService";

  private readonly repository: string;
  private readonly spoolDir: string;

  constructor(
    options: { repository?: string; spoolDir?: string } = {
      repository: appConfig.NODE_AGENT_UPDATE_REPO,
      spoolDir: appConfig.NODE_AGENT_UPDATE_SPOOL,
    },
  ) {
    this.repository = options.repository?.trim() ?? "";
    this.spoolDir = options.spoolDir?.trim() ?? "";
  }

  /**
   * Whether this host has been wired for in-panel updates at all. The feature
   * is opt-in (infra/node/scripts/install-agent-updater.sh); without it there is
   * nothing watching the spool, and a request would vanish into a directory.
   */
  isAvailable(): boolean {
    if (!this.repository || !this.spoolDir) return false;

    try {
      // Synchronous on purpose: this decides between 501 and doing the work on
      // the request path, and it is a single access(2) on a local directory.
      accessSync(this.spoolDir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** The repository whose digests this node accepts, for the panel to show. */
  getRepository(): string {
    return this.repository;
  }

  /**
   * Record a request for the host-side updater. Returns the id the result will
   * carry, so a caller can match one to the other.
   */
  async requestUpdate(image: string): Promise<{ id: string; image: string }> {
    this.assertAvailable();

    if (!isPublishableAgentImage(image, this.repository)) {
      throw new APIError(ClientErrorCode.BAD_REQUEST, {
        msg: "services.server.UPDATE_INVALID_IMAGE",
      });
    }

    const request = {
      id: randomUUID(),
      image,
      requestedAt: new Date().toISOString(),
    };
    const body = `${JSON.stringify(request)}\n`;

    // pending first: if the agent dies between the two writes, the node is left
    // with a marker and no trigger, which reads as "running" and resolves the
    // moment a result appears - never as a request that was silently dropped.
    await this.writeAtomic(PENDING_FILE, body);
    await this.writeAtomic(REQUEST_FILE, body);

    appLogger.info(`Запрошено обновление агента: ${image}`);

    return { id: request.id, image };
  }

  /**
   * The current state, derived entirely from the spool.
   *
   * - the trigger is still there            -> requested
   * - it is gone and no result matches it   -> running (the swap is happening)
   * - a result is there                     -> succeeded / failed
   * - nothing at all                        -> idle
   */
  async getStatus(): Promise<AgentUpdateStatus> {
    if (!this.isAvailable()) {
      return { state: "idle", image: null, log: "", updatedAt: null, message: null };
    }

    const [hasRequest, pending, result, log] = await Promise.all([
      this.exists(REQUEST_FILE),
      this.readJson<PendingRequest>(PENDING_FILE),
      this.readJson<SpoolResult>(RESULT_FILE),
      this.readLogTail(),
    ]);

    const resultIsForPending = Boolean(
      pending?.id && result?.id && pending.id === result.id,
    );

    let state: AgentUpdateState = "idle";
    let image: string | null = null;

    if (hasRequest) {
      state = "requested";
      image = pending?.image ?? null;
    } else if (pending?.id && !resultIsForPending) {
      state = "running";
      image = pending.image ?? null;
    } else if (result) {
      state = result.ok ? "succeeded" : "failed";
      image = result.image || pending?.image || null;
    }

    return {
      state,
      image,
      log,
      updatedAt: state === "succeeded" || state === "failed" ? result?.finishedAt ?? null : null,
      message: result?.message ?? null,
    };
  }

  private assertAvailable(): void {
    if (this.isAvailable()) return;

    throw new APIError(ServerErrorCode.NOT_IMPLEMENTED, {
      msg: "services.server.UPDATE_UNAVAILABLE",
    });
  }

  private spoolPath(name: string): string {
    return path.join(this.spoolDir, name);
  }

  /**
   * Write via a fresh temp file and rename. The rename replaces whatever is at
   * the target - including a symlink someone planted there - instead of writing
   * through it, and a reader never sees a half-written request.
   */
  private async writeAtomic(name: string, body: string): Promise<void> {
    const target = this.spoolPath(name);
    const tmp = `${target}.${randomUUID()}.tmp`;

    await fs.writeFile(tmp, body, { mode: 0o600 });
    try {
      await fs.rename(tmp, target);
    } catch (error) {
      await fs.rm(tmp, { force: true });
      throw error;
    }
  }

  private async exists(name: string): Promise<boolean> {
    try {
      await fs.access(this.spoolPath(name));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * A spool file the agent did not write is untrusted input: it is read for
   * display only, and anything unparseable is treated as absent. A node that
   * cannot parse its own spool must still answer - a 500 here looks to the panel
   * exactly like a node that is down.
   */
  private async readJson<T>(name: string): Promise<T | null> {
    try {
      const raw = await fs.readFile(this.spoolPath(name), "utf8");
      const parsed: unknown = JSON.parse(raw);

      return parsed && typeof parsed === "object" ? (parsed as T) : null;
    } catch {
      return null;
    }
  }

  private async readLogTail(): Promise<string> {
    try {
      const raw = await fs.readFile(this.spoolPath(LOG_FILE), "utf8");

      return raw.length > MAX_LOG_BYTES ? raw.slice(-MAX_LOG_BYTES) : raw;
    } catch {
      return "";
    }
  }
}
