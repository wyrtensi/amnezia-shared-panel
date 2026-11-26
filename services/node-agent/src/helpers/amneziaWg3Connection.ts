import {
  RunOptions,
  ClientTableEntry,
  IAmneziaConnection,
} from "@/types/amnezia";
import {
  isDockerDaemonUnavailableError,
  isDockerContainerUnavailableError,
} from "@/utils/dockerErrors";
import { exec, execFile } from "child_process";
import { APIError } from "@/utils/APIError";
import { AppContract } from "@/contracts/app";
import { CommandResult } from "@/types/shared";
import { TimeContract } from "@/contracts/time";
import { ServerErrorCode } from "@/types/shared";
import {
  buildValidatedWgConfigCommand,
  buildWriteFileCommand,
  encodeWritePayload,
} from "@/utils/shellWrite";
import { runWithInput as runCommandWithInput } from "@/utils/execWithInput";
import { redactCommand } from "@/utils/redactCommand";

/**
 * Connection to the AmneziaWG 3.1 container.
 */
export class AmneziaWg3Connection implements IAmneziaConnection {
  static key = "amneziaWg3";

  /**
   * Execute a command inside the container (or on the host when unconfigured).
   */
  run(cmd: string, options?: RunOptions): Promise<CommandResult> {
    const timeout = options?.timeout ?? 5 * TimeContract.SECOND;
    const maxBuffer = options?.maxBufferBytes ?? 10 * 1024 * 1024;
    const container = AppContract.AmneziaWG3.DOCKER_CONTAINER;

    return new Promise((resolve, reject) => {
      const handleResult = (
        error: Error | null,
        stdout: string,
        stderr: string,
      ) => {
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
      };

      // Avoid spawning an intermediate /bin/sh for docker exec so timeout kills docker directly.
      if (container) {
        execFile(
          "docker",
          ["exec", container, "sh", "-lc", cmd],
          { timeout, maxBuffer },
          handleResult,
        );
      } else {
        exec(cmd, { timeout, maxBuffer }, handleResult);
      }
    });
  }

  /**
   * Execute a command inside the container with its payload on stdin.
   */
  runWithInput(
    cmd: string,
    input: string,
    options?: RunOptions,
  ): Promise<CommandResult> {
    return runCommandWithInput({
      container: AppContract.AmneziaWG3.DOCKER_CONTAINER,
      cmd,
      input,
      timeout: options?.timeout,
      maxBufferBytes: options?.maxBufferBytes,
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
    await this.runWithInput(
      buildWriteFileCommand(path),
      encodeWritePayload(content),
    );
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
    await this.runWithInput(
      buildValidatedWgConfigCommand(
        AppContract.AmneziaWG3.PATHS.WG_CONF,
        "awg-quick",
      ),
      encodeWritePayload(content),
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
