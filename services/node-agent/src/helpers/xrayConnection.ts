import {
  isDockerDaemonUnavailableError,
  isDockerContainerUnavailableError,
} from "@/utils/dockerErrors";
import { exec, execFile } from "child_process";
import { APIError } from "@/utils/APIError";
import { RunOptions } from "@/types/amnezia";
import { AppContract } from "@/contracts/app";
import { CommandResult } from "@/types/shared";
import { TimeContract } from "@/contracts/time";
import { ServerErrorCode } from "@/types/shared";
import {
  buildWriteFileCommand,
  encodeWritePayload,
} from "@/utils/shellWrite";
import { runWithInput as runCommandWithInput } from "@/utils/execWithInput";
import { redactCommand } from "@/utils/redactCommand";

/**
 * Connection to the Xray container.
 */
export class XrayConnection {
  static key = "xray";

  /**
   * Execute a command inside the container (or on the host when unconfigured).
   */
  run(cmd: string, options?: RunOptions): Promise<CommandResult> {
    const timeout = options?.timeout ?? 5 * TimeContract.SECOND;
    const maxBuffer = options?.maxBufferBytes ?? 10 * 1024 * 1024;
    const container = AppContract.Xray.DOCKER_CONTAINER;

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
              `Ошибка выполнения команды ${redactCommand(cmd)}: ${redactCommand(String(error))}`,
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
   * Выполнить команду на хосте (вне контейнера)
   */
  runOnHost(cmd: string, options?: RunOptions): Promise<CommandResult> {
    const timeout = options?.timeout ?? 5 * TimeContract.SECOND;
    const maxBuffer = options?.maxBufferBytes ?? 10 * 1024 * 1024;

    return new Promise((resolve, reject) => {
      exec(cmd, { timeout, maxBuffer }, (error, stdout, stderr) => {
        if (error) {
          return reject(
            new Error(
              `Ошибка выполнения команды ${redactCommand(cmd)}: ${redactCommand(String(error))}`,
            ),
          );
        }

        resolve({ stdout, stderr });
      });
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
      container: AppContract.Xray.DOCKER_CONTAINER,
      cmd,
      input,
      timeout: options?.timeout,
      maxBufferBytes: options?.maxBufferBytes,
    });
  }

  /**
   * Прочитать файл
   */
  async readFile(path: string): Promise<string> {
    const { stdout } = await this.run(`cat ${path} 2>/dev/null || true`);

    return stdout;
  }

  /**
   * Записать файл
   */
  async writeFile(path: string, content: string): Promise<void> {
    await this.runWithInput(
      buildWriteFileCommand(path),
      encodeWritePayload(content),
    );
  }

  /**
   * Прочитать конфигурацию сервера
   */
  async readServerConfig(): Promise<string> {
    return this.readFile(AppContract.Xray.PATHS.SERVER_CONFIG);
  }

  /**
   * Записать конфигурацию сервера
   */
  async writeServerConfig(content: string): Promise<void> {
    await this.writeFile(AppContract.Xray.PATHS.SERVER_CONFIG, content);
  }

  /**
   * Restart the Xray container directly without an intermediate shell.
   */
  restartContainer(): Promise<void> {
    const container = AppContract.Xray.DOCKER_CONTAINER;
    if (!container) return Promise.resolve();

    return new Promise((resolve, reject) => {
      execFile(
        "docker",
        ["restart", container],
        {
          timeout: 5 * TimeContract.SECOND,
          maxBuffer: 10 * 1024 * 1024,
        },
        (error) => {
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
                `Ошибка выполнения команды ${redactCommand(`docker restart ${container}`)}: ${redactCommand(String(error))}`,
              ),
            );
          }

          resolve();
        },
      );
    });
  }
}
