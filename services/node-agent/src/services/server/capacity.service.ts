import { randomUUID } from "crypto";
import { accessSync, constants } from "fs";
import fs from "fs/promises";
import path from "path";

import appConfig from "@/constants/appConfig";
import { appLogger } from "@/config/winstonLogger";
import { CapacityState, CapacityStatus } from "@/types/server";
import { APIError } from "@/utils/APIError";
import { ClientErrorCode, ServerErrorCode } from "@/types/shared";

/** The trigger the host-side path unit watches. Deleted by the applier. */
const REQUEST_FILE = "request.json";
/** The agent's own copy of the last request. The applier never touches it. */
const PENDING_FILE = "pending.json";
/** What the applier writes when it is done. */
const RESULT_FILE = "result.json";
const LOG_FILE = "apply.log";

/** A failure's reason is on the last lines, so the tail is what is kept. */
const MAX_LOG_BYTES = 64 * 1024;

/**
 * Largest capacity this agent will pass on.
 *
 * infra/node/scripts/set-capacity.sh accepts up to 1000 - the physical bound of
 * the /22 both AWG interfaces are pinned to - and preflight.sh warns above 500,
 * the validated one. Nothing in this system offers more than 500 today, so that
 * is what the agent accepts: a conduit should not be the component that widens a
 * limit nobody has tested.
 */
const MAX_PEERS = 500;

interface SpoolResult {
  id?: string;
  finishedAt?: string;
  ok?: boolean;
  maxPeers?: number;
  message?: string;
}

interface PendingRequest {
  id?: string;
  maxPeers?: number;
  requestedAt?: string;
}

/**
 * The agent's half of the capacity mechanism.
 *
 * SERVER_MAX_PEERS is read once at container start (constants/appConfig.ts), and
 * it lives in the node's .env - a file this container deliberately cannot write,
 * because the node's own preflight validates it. The agent has no compose binary
 * either, so it cannot recreate itself. It therefore only records a request;
 * infra/node/scripts/capacity-apply.sh, running on the host under systemd, edits
 * the .env, runs set-capacity.sh and writes the outcome back here.
 *
 * Modelled on AgentUpdateService, deliberately in a SEPARATE spool: an agent
 * update in flight must not block a capacity change, and neither should be able
 * to read the other's result as its own.
 *
 * Everything about the state lives in the spool rather than in memory, because
 * applying a change recreates this container - the process answering a status
 * call is usually not the process that made the request.
 */
export class CapacityService {
  static key = "capacityService";

  private readonly spoolDir: string;

  /**
   * The config is read in the body for the reason spelled out on
   * AgentUpdateService's constructor: awilix's CLASSIC mode parses this
   * parameter list as text, and a comma inside a default object literal turns
   * into a dependency the container cannot resolve. One property has no comma,
   * so this one happened to survive - adding a second option would have broken
   * it exactly as it broke the update service.
   */
  constructor(options: { spoolDir?: string } = {}) {
    const spoolDir = options.spoolDir ?? appConfig.NODE_AGENT_CAPACITY_SPOOL;

    this.spoolDir = spoolDir?.trim() ?? "";
  }

  /**
   * Whether this host has been wired for in-panel capacity changes at all. The
   * feature is opt-in (infra/node/scripts/install-capacity-applier.sh); without it
   * nothing watches the spool and a request would vanish into a directory.
   */
  isAvailable(): boolean {
    if (!this.spoolDir) return false;

    try {
      // Synchronous on purpose: this decides between 501 and doing the work on
      // the request path, and it is a single access(2) on a local directory.
      accessSync(this.spoolDir, constants.W_OK);
      return true;
    } catch {
      return false;
    }
  }

  /** What the node is running right now, for the panel to compare against. */
  getCurrentMaxPeers(): number {
    return appConfig.SERVER_MAX_PEERS || 0;
  }

  /**
   * Record a request for the host-side applier. Returns the id the result will
   * carry, so a caller can match one to the other.
   */
  async requestCapacity(maxPeers: number): Promise<{
    id: string;
    maxPeers: number;
  }> {
    this.assertAvailable();

    if (!Number.isInteger(maxPeers) || maxPeers < 1 || maxPeers > MAX_PEERS) {
      throw new APIError(ClientErrorCode.BAD_REQUEST, {
        msg: "services.server.CAPACITY_INVALID",
      });
    }

    // One change at a time. The applier edits .env and recreates a container;
    // two requests racing would interleave those steps, and the loser would
    // read the winner's result as its own.
    if (await this.exists(REQUEST_FILE)) {
      throw new APIError(ClientErrorCode.CONFLICT, {
        msg: "services.server.CAPACITY_IN_FLIGHT",
      });
    }

    const request = {
      id: randomUUID(),
      maxPeers,
      requestedAt: new Date().toISOString(),
    };
    const body = `${JSON.stringify(request)}\n`;

    // pending first: if the agent dies between the two writes, the node is left
    // with a marker and no trigger, which reads as "running" and resolves the
    // moment a result appears - never as a request that was silently dropped.
    await this.writeAtomic(PENDING_FILE, body);
    await this.writeAtomic(REQUEST_FILE, body);

    appLogger.info(`Запрошено изменение ёмкости: ${maxPeers}`);

    return { id: request.id, maxPeers };
  }

  /**
   * The current state, derived entirely from the spool.
   *
   * - the trigger is still there            -> requested
   * - it is gone and no result matches it   -> running (the change is happening)
   * - a result is there                     -> succeeded / failed
   * - nothing at all                        -> idle
   */
  async getStatus(): Promise<CapacityStatus> {
    if (!this.isAvailable()) {
      return {
        state: "idle",
        requestedMaxPeers: null,
        log: "",
        updatedAt: null,
        message: null,
      };
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

    let state: CapacityState = "idle";
    let requestedMaxPeers: number | null = null;

    if (hasRequest) {
      state = "requested";
      requestedMaxPeers = pending?.maxPeers ?? null;
    } else if (pending?.id && !resultIsForPending) {
      state = "running";
      requestedMaxPeers = pending.maxPeers ?? null;
    } else if (result) {
      state = result.ok ? "succeeded" : "failed";
      requestedMaxPeers = result.maxPeers ?? pending?.maxPeers ?? null;
    }

    return {
      state,
      requestedMaxPeers,
      log,
      updatedAt:
        state === "succeeded" || state === "failed"
          ? (result?.finishedAt ?? null)
          : null,
      message: result?.message ?? null,
    };
  }

  private assertAvailable(): void {
    if (this.isAvailable()) return;

    throw new APIError(ServerErrorCode.NOT_IMPLEMENTED, {
      msg: "services.server.CAPACITY_UNAVAILABLE",
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
