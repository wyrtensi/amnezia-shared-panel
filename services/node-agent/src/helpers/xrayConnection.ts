import {
  isDockerDaemonUnavailableError,
  isDockerContainerUnavailableError,
} from "@/utils/dockerErrors";
import { exec } from "child_process";
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
 * Создать соединение с Xray
 */
export class XrayConnection {
  static key = "xray";

  /**
   * Построить команду
   */
  private buildCommand(cmd: string): string {
    if (!AppContract.Xray.DOCKER_CONTAINER) return cmd;

    return `docker exec ${
      AppContract.Xray.DOCKER_CONTAINER
    } sh -lc '${cmd.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Выполнить команду внутри контейнера
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
              `Ошибка выполнения команды ${redactCommand(cmd)}: ${redactCommand(String(error))}`,
            ),
          );
        }

        resolve({ stdout, stderr });
      });
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
   * Перезапустить контейнер Xray
   */
  async restartContainer(): Promise<void> {
    if (!AppContract.Xray.DOCKER_CONTAINER) return;

    await this.runOnHost(`docker restart ${AppContract.Xray.DOCKER_CONTAINER}`);
  }
}
