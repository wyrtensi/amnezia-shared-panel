import { randomUUID } from "crypto";
import { accessSync, constants } from "fs";
import fs from "fs/promises";
import path from "path";

import appConfig from "@/constants/appConfig";
import { appLogger } from "@/config/winstonLogger";
import { AgentUpdateStatus, AgentUpdateState } from "@/types/server";
import { isPublishableAgentImage } from "@/utils/agentImage";
import { APIError } from "@/utils/APIError";
import { MAX_LOG_BYTES, readLogTail } from "@/utils/logTail";
import { ClientErrorCode, ServerErrorCode } from "@/types/shared";

/** The trigger the host-side path unit watches. Deleted by the updater. */
const REQUEST_FILE = "request.json";
/** The agent's own copy of the last request. The updater never touches it. */
const PENDING_FILE = "pending.json";
/** What the updater writes when it is done. */
const RESULT_FILE = "result.json";
const LOG_FILE = "update.log";

/**
 * How long a `pending.json` is allowed to go without a matching `result.json`
 * before the agent declares it dead rather than "running".
 *
 * infra/node/systemd/amnezia-node-agent-update.service sets
 * TimeoutStartSec=900 (a pull is the slow part on a small VPS, plus up to 90s
 * for the health gate). This must sit above that so systemd has already given
 * up on the unit before the agent gives up on the request; the ~5 minute
 * margin covers systemd's own SIGTERM-then-SIGKILL grace period past
 * TimeoutStartSec plus ordinary clock/scheduling slack.
 */
const UPDATE_DEADLINE_MS = 20 * 60 * 1000;

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

  /**
   * The config is read in the body, not in a default parameter value.
   *
   * The container runs in awilix's CLASSIC mode, which derives dependency names
   * by parsing this parameter list as text. A comma inside a default object
   * literal reads to that parser as a parameter separator, so the second
   * property became a required dependency named after the expression behind it
   * - and every resolve of this service died with "Could not resolve
   * 'appConfig_1.default.NODE_AGENT_UPDATE_SPOOL'", i.e. a 500 on both
   * /server/update routes. The empty default keeps the options escape hatch
   * tests use without handing the parser a comma.
   */
  constructor(options: { repository?: string; spoolDir?: string } = {}) {
    const repository = options.repository ?? appConfig.NODE_AGENT_UPDATE_REPO;
    const spoolDir = options.spoolDir ?? appConfig.NODE_AGENT_UPDATE_SPOOL;

    this.repository = repository?.trim() ?? "";
    this.spoolDir = spoolDir?.trim() ?? "";
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

    // One change at a time, but only while that change is still alive. Mirrors
    // CapacityService.requestCapacity: the updater pulls the image and
    // recreates the container, so two requests racing would interleave those
    // steps and the loser would read the winner's result as its own. Once the
    // pending marker is past isPastDeadline - the same test getStatus uses to
    // stop reporting "running" - the host updater is presumed dead, so a new
    // request must be able to replace the stale trigger rather than 409
    // forever with no way for the panel to recover but SSH. A request.json
    // with no readable pending.json (missing, or a requestedAt that will not
    // parse) cannot be bounded, so it is treated the same as expired.
    if (await this.exists(REQUEST_FILE)) {
      const pending = await this.readJson<PendingRequest>(PENDING_FILE);

      if (!this.isPastDeadline(pending?.requestedAt)) {
        throw new APIError(ClientErrorCode.CONFLICT, {
          msg: "services.server.UPDATE_IN_FLIGHT",
        });
      }
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
      readLogTail(this.spoolPath(LOG_FILE), MAX_LOG_BYTES),
    ]);

    const resultIsForPending = Boolean(
      pending?.id && result?.id && pending.id === result.id,
    );

    let state: AgentUpdateState = "idle";
    let image: string | null = null;
    let message: string | null = null;
    let updatedAt: string | null = null;

    if (pending?.id && !resultIsForPending) {
      // Unresolved: either the trigger is still there (requested) or it has
      // been consumed with no result yet (running). Both windows share one
      // deadline - a masked or stopped .path unit can pin either state
      // forever otherwise, and the worker re-polls the node on every tick
      // while it sits in one of them.
      if (this.isPastDeadline(pending.requestedAt)) {
        state = "failed";
        image = pending.image ?? null;
        message = "The host updater exited without writing a result before the deadline.";
        updatedAt = new Date().toISOString();
      } else {
        state = hasRequest ? "requested" : "running";
        image = pending.image ?? null;
      }
    } else if (result) {
      state = result.ok ? "succeeded" : "failed";
      image = result.image || pending?.image || null;
      message = result.message ?? null;
      updatedAt = result.finishedAt ?? null;
    }

    return { state, image, log, updatedAt, message };
  }

  /**
   * Whether `requestedAt` is far enough in the past that the host updater
   * must be considered dead rather than merely slow.
   *
   * `now < deadline` is false both when the deadline has passed AND when
   * `deadline` is NaN - an unparseable or missing `requestedAt` makes
   * `Date.parse` return NaN, and NaN compares false to every number. That is
   * deliberate: a pending marker this agent cannot date is exactly the one it
   * cannot bound, so it must fail closed as expired rather than as "still
   * running".
   */
  private isPastDeadline(requestedAt: string | undefined): boolean {
    const deadline = Date.parse(requestedAt ?? "") + UPDATE_DEADLINE_MS;

    return !(Date.now() < deadline);
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
}
