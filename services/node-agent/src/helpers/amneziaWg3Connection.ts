import {
  RunOptions,
  ClientTableEntry,
  IAmneziaConnection,
} from "@/types/amnezia";
import {
  isDockerDaemonUnavailableError,
  isDockerContainerUnavailableError,
} from "@/utils/dockerErrors";
import { exec } from "child_process";
import { APIError } from "@/utils/APIError";
import { AppContract } from "@/contracts/app";
import { CommandResult } from "@/types/shared";
import { TimeContract } from "@/contracts/time";
import { ServerErrorCode } from "@/types/shared";
import {
  buildValidatedWgConfigCommand,
  buildWriteFileCommand,
} from "@/utils/shellWrite";
import { redactCommand } from "@/utils/redactCommand";

/**
 * Connection to the AmneziaWG 3.1 container.
 */
export class AmneziaWg3Connection implements IAmneziaConnection {
  static key = "amneziaWg3";

  /**
   * Build a command scoped to the AmneziaWG 3.1 container.
   */
  private buildCommand(cmd: string): string {
    if (!AppContract.AmneziaWG3.DOCKER_CONTAINER) return cmd;

    return `docker exec ${
      AppContract.AmneziaWG3.DOCKER_CONTAINER
    } sh -lc '${cmd.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Execute a command inside the container.
   */
  run(cmd: string, options?: RunOptions): Promise<CommandResult> {
    const finalCmd = this.buildCommand(cmd);
    const timeout = options?.timeout ?? 5 * TimeContract.SECOND;
    const maxBuffer = options?.maxBufferBytes ?? 10 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      exec(finalCmd, { timeout, maxBuffer }, (error, stdout, stderr) => {
        if (error) {
          if (isDockerDaemonUnavailableError(error)) {
            return reject(
              new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
                msg: "swagger.errors.DOCKER_NOT_AVAILABLE",
              }),
            );
          }

          if (isDockerContainerUnavailableError(error)) {
            return reject(
              new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
                msg: "swagger.errors.CONTAINER_NOT_AVAILABLE",
              }),
            );
          }

          return reject(
            new Error(
              `Failed to run command ${redactCommand(cmd)}: ${redactCommand(String(error))}`,
            ),
          );
        }

        resolve({ stdout, stderr });
      });
    });
  }

  /**
   * Read a file from the container.
   */
  async readFile(path: string): Promise<string> {
    const { stdout } = await this.run(`cat ${path} 2>/dev/null || true`);

    return stdout;
  }

  /**
   * Write a file into the container.
   */
  async writeFile(path: string, content: string): Promise<void> {
    await this.run(buildWriteFileCommand(path, content));
  }

  /**
   * Read awg0.conf.
   */
  async readWgConfig(): Promise<string> {
    const { stdout } = await this.run(
      `cat ${AppContract.AmneziaWG3.PATHS.WG_CONF} 2>/dev/null || true`,
    );

    return stdout;
  }

  /**
   * Write and validate awg0.conf.
   */
  async writeWgConfig(content: string): Promise<void> {
    await this.run(
      buildValidatedWgConfigCommand(
        AppContract.AmneziaWG3.PATHS.WG_CONF,
        content,
        "awg-quick",
      ),
    );
  }

  /**
   * Get the live WireGuard dump.
   */
  async getWgDump(): Promise<string> {
    if (!AppContract.AmneziaWG3.INTERFACE) return "";

    const { stdout } = await this.run(
      `awg show ${AppContract.AmneziaWG3.INTERFACE} dump`,
    );

    return stdout;
  }

  /**
   * Apply the WireGuard configuration to the live interface.
   */
  async syncWgConfig(): Promise<void> {
    if (!AppContract.AmneziaWG3.INTERFACE) return;

    await this.run(
      `awg syncconf ${AppContract.AmneziaWG3.INTERFACE} <(awg-quick strip ${AppContract.AmneziaWG3.PATHS.WG_CONF})`,
    );
  }

  /**
   * Get the server public key.
   */
  async getServerPublicKey(): Promise<string> {
    const { stdout } = await this.run(
      `cat ${AppContract.AmneziaWG3.PATHS.SERVER_PUBLIC_KEY} 2>/dev/null || true`,
    );

    return stdout;
  }

  /**
   * Read the clients table.
   */
  async readClientsTable(): Promise<ClientTableEntry[]> {
    const raw = await this.readFile(
      AppContract.AmneziaWG3.PATHS.CLIENTS_TABLE || "",
    );

    try {
      const parsed = JSON.parse(raw || "[]") as unknown;

      if (Array.isArray(parsed)) {
        return parsed as ClientTableEntry[];
      }

      if (parsed && typeof parsed === "object") {
        const obj = parsed as Record<string, unknown>;
        return Object.keys(obj).map((clientId) => ({
          clientId,
          userData:
            obj?.[clientId] && typeof obj[clientId] === "object"
              ? (obj[clientId] as ClientTableEntry["userData"])
              : undefined,
        }));
      }

      return [];
    } catch {
      return [];
    }
  }

  /**
   * Write the clients table.
   */
  async writeClientsTable(table: ClientTableEntry[]): Promise<void> {
    const payload = JSON.stringify(table);

    await this.writeFile(
      AppContract.AmneziaWG3.PATHS.CLIENTS_TABLE || "",
      payload,
    );
  }
}
