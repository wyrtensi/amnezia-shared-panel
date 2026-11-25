import http from "node:http";

import { appLogger } from "@/config/winstonLogger";
import appConfig from "@/constants/appConfig";
import {
  ApplyEgressStateResponse,
  DesiredPeer,
  DesiredState,
  EgressHttpCheckRequest,
  EgressHttpCheckResponse,
  EgressMode,
  HostNetworkReport,
  SwitchEgressModeResponse,
  VerifyExitRequest,
  VerifyExitResponse,
} from "@/types/egress";
import { ClientErrorCode, ServerErrorCode } from "@/types/shared";
import { APIError } from "@/utils/APIError";

const DEFAULT_TIMEOUT_MS = 10_000;
const SWITCH_MODE_TIMEOUT_MS = 90_000;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

const UNAVAILABLE_ERRNO = new Set([
  "ENOENT",
  "ECONNREFUSED",
  "EACCES",
  "EPERM",
  "ENOTSOCK",
  "ECONNRESET",
  "EPIPE",
]);

class EgressDaemonUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EgressDaemonUnavailableError";
  }
}

type DaemonErrorPayload = {
  ok?: boolean;
  error?: string;
};

/**
 * HTTP-over-Unix-socket client for the host `amnezia-egressd` daemon.
 *
 * When the socket is absent (masquerade/legacy nodes, dev environments),
 * passive reads (`getReport`, `getState`, peer hooks) return `null` silently
 * without log spam; explicit control actions fail with 503.
 */
export class EgressService {
  static key = "egressService";

  private readonly socketPath: string;
  private loggedUnavailable = false;

  /**
   * Single-property object literal without commas matches Awilix CLASSIC
   * constructor text parsing (same pattern as CapacityService).
   */
  constructor(options: { socketPath?: string } = {}) {
    const raw = options.socketPath ?? appConfig.NODE_EGRESS_SOCKET ?? "";
    this.socketPath = raw.trim();
  }

  isConfigured(): boolean {
    return this.socketPath.length > 0;
  }

  async getReport(): Promise<HostNetworkReport | null> {
    if (!this.isConfigured()) return null;
    try {
      const { status, data } = await this.requestJson<HostNetworkReport>(
        "GET",
        "/v1/report",
      );
      if (status >= 200 && status < 300) {
        this.loggedUnavailable = false;
        return data;
      }
      return null;
    } catch (error) {
      if (error instanceof EgressDaemonUnavailableError) {
        this.logUnavailableOnce(error.message);
        return null;
      }
      appLogger.warn(`Failed to query amnezia-egressd report: ${error}`);
      return null;
    }
  }

  async getState(): Promise<DesiredState | null> {
    if (!this.isConfigured()) return null;
    try {
      const { status, data } = await this.requestJson<DesiredState>(
        "GET",
        "/v1/state",
      );
      if (status >= 200 && status < 300) {
        this.loggedUnavailable = false;
        return data;
      }
      return null;
    } catch (error) {
      if (error instanceof EgressDaemonUnavailableError) {
        this.logUnavailableOnce(error.message);
        return null;
      }
      appLogger.warn(`Failed to query amnezia-egressd state: ${error}`);
      return null;
    }
  }

  async applyState(state: DesiredState): Promise<ApplyEgressStateResponse> {
    this.requireConfigured();
    try {
      const { status, data } = await this.requestJson<
        ApplyEgressStateResponse & DaemonErrorPayload
      >("PUT", "/v1/state", state);
      this.throwIfDaemonError(status, data);
      this.loggedUnavailable = false;
      return data;
    } catch (error) {
      throw this.mapControlError(error);
    }
  }

  async upsertPeer(
    peer: DesiredPeer,
  ): Promise<ApplyEgressStateResponse | null> {
    if (!this.isConfigured()) return null;
    try {
      const { status, data } = await this.requestJson<
        ApplyEgressStateResponse & DaemonErrorPayload
      >("POST", "/v1/peers/upsert", { peer });
      if (status >= 200 && status < 300) {
        this.loggedUnavailable = false;
        return data;
      }
      appLogger.warn(
        `amnezia-egressd upsertPeer returned HTTP ${status}: ${data?.error ?? "unknown error"}`,
      );
      return null;
    } catch (error) {
      if (error instanceof EgressDaemonUnavailableError) {
        this.logUnavailableOnce(error.message);
        return null;
      }
      appLogger.warn(`amnezia-egressd upsertPeer failed: ${error}`);
      return null;
    }
  }

  async removePeer(
    tunnelIpv4: string,
  ): Promise<ApplyEgressStateResponse | null> {
    if (!this.isConfigured()) return null;
    try {
      const { status, data } = await this.requestJson<
        ApplyEgressStateResponse & DaemonErrorPayload
      >("POST", "/v1/peers/remove", { tunnelIpv4 });
      if (status >= 200 && status < 300) {
        this.loggedUnavailable = false;
        return data;
      }
      appLogger.warn(
        `amnezia-egressd removePeer returned HTTP ${status}: ${data?.error ?? "unknown error"}`,
      );
      return null;
    } catch (error) {
      if (error instanceof EgressDaemonUnavailableError) {
        this.logUnavailableOnce(error.message);
        return null;
      }
      appLogger.warn(`amnezia-egressd removePeer failed: ${error}`);
      return null;
    }
  }

  async verifyExit(req: VerifyExitRequest): Promise<VerifyExitResponse> {
    this.requireConfigured();
    const timeoutMs = Math.max(
      DEFAULT_TIMEOUT_MS,
      (req.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 2_000,
    );
    try {
      const { status, data } = await this.requestJson<
        VerifyExitResponse & DaemonErrorPayload
      >("POST", "/v1/verify-exit", req, timeoutMs);
      this.throwIfDaemonError(status, data);
      this.loggedUnavailable = false;
      return data;
    } catch (error) {
      throw this.mapControlError(error);
    }
  }

  async runHttpCheck(
    req: EgressHttpCheckRequest,
  ): Promise<EgressHttpCheckResponse> {
    this.requireConfigured();
    const timeoutMs = Math.max(
      DEFAULT_TIMEOUT_MS,
      (req.timeoutMs ?? DEFAULT_TIMEOUT_MS) + 2_000,
    );
    try {
      const { status, data } = await this.requestJson<
        EgressHttpCheckResponse & DaemonErrorPayload
      >("POST", "/v1/checks/http", req, timeoutMs);
      this.throwIfDaemonError(status, data);
      this.loggedUnavailable = false;
      return data;
    } catch (error) {
      throw this.mapControlError(error);
    }
  }

  async switchMode(mode: EgressMode): Promise<SwitchEgressModeResponse> {
    this.requireConfigured();
    try {
      const { status, data } = await this.requestJson<
        SwitchEgressModeResponse & DaemonErrorPayload
      >("POST", "/v1/switch-mode", { mode }, SWITCH_MODE_TIMEOUT_MS);
      if (status === 409 || (status >= 200 && status < 300 && !data.ok)) {
        throw new APIError(ClientErrorCode.CONFLICT);
      }
      this.throwIfDaemonError(status, data);
      this.loggedUnavailable = false;
      return data;
    } catch (error) {
      throw this.mapControlError(error);
    }
  }

  private requireConfigured(): void {
    if (!this.isConfigured()) {
      throw new APIError(ServerErrorCode.SERVICE_UNAVAILABLE);
    }
  }

  private logUnavailableOnce(detail: string): void {
    if (!this.loggedUnavailable) {
      this.loggedUnavailable = true;
      appLogger.verbose(
        `amnezia-egressd socket unavailable (${this.socketPath}): ${detail}`,
      );
    }
  }

  private throwIfDaemonError(status: number, data?: DaemonErrorPayload): void {
    if (status >= 200 && status < 300) return;
    if (data?.error) {
      appLogger.warn(`amnezia-egressd HTTP ${status}: ${data.error}`);
    }
    if (status === 400) {
      throw new APIError(ClientErrorCode.BAD_REQUEST);
    }
    if (status === 409) {
      throw new APIError(ClientErrorCode.CONFLICT);
    }
    throw new APIError(ServerErrorCode.SERVICE_UNAVAILABLE);
  }

  private mapControlError(error: unknown): unknown {
    if (error instanceof APIError) return error;
    if (error instanceof EgressDaemonUnavailableError) {
      this.logUnavailableOnce(error.message);
      return new APIError(ServerErrorCode.SERVICE_UNAVAILABLE);
    }
    appLogger.warn(`amnezia-egressd control call failed: ${error}`);
    return new APIError(ServerErrorCode.SERVICE_UNAVAILABLE);
  }

  private requestJson<T>(
    method: "GET" | "POST" | "PUT",
    path: string,
    body?: unknown,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<{ status: number; data: T }> {
    return new Promise((resolve, reject) => {
      const payload = body === undefined ? undefined : JSON.stringify(body);
      const headers: Record<string, string | number> = {
        Accept: "application/json",
      };
      if (payload !== undefined) {
        headers["Content-Type"] = "application/json";
        headers["Content-Length"] = Buffer.byteLength(payload, "utf8");
      }

      const req = http.request(
        {
          socketPath: this.socketPath,
          path,
          method,
          headers,
          timeout: timeoutMs,
        },
        (res) => {
          const chunks: Buffer[] = [];
          let totalBytes = 0;

          res.on("data", (chunk: Buffer) => {
            totalBytes += chunk.length;
            if (totalBytes > MAX_RESPONSE_BYTES) {
              req.destroy(new Error("egressd response exceeded byte limit"));
              return;
            }
            chunks.push(chunk);
          });

          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8").trim();
            if (!text) {
              resolve({ status: res.statusCode ?? 500, data: {} as T });
              return;
            }
            try {
              const parsed = JSON.parse(text) as T;
              resolve({ status: res.statusCode ?? 500, data: parsed });
            } catch (parseError) {
              reject(
                new Error(
                  `invalid JSON from amnezia-egressd (${path}): ${(parseError as Error).message}`,
                ),
              );
            }
          });
        },
      );

      req.on("timeout", () => {
        req.destroy(
          new EgressDaemonUnavailableError(
            `request timed out after ${timeoutMs}ms`,
          ),
        );
      });

      req.on("error", (err: NodeJS.ErrnoException) => {
        if (err instanceof EgressDaemonUnavailableError) {
          reject(err);
          return;
        }
        if (err.code && UNAVAILABLE_ERRNO.has(err.code)) {
          reject(new EgressDaemonUnavailableError(err.message));
          return;
        }
        reject(err);
      });

      if (payload !== undefined) {
        req.write(payload);
      }
      req.end();
    });
  }
}
