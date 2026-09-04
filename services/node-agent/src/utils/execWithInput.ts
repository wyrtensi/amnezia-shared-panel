import { spawn } from "child_process";

import {
  isDockerContainerUnavailableError,
  isDockerDaemonUnavailableError,
} from "@/utils/dockerErrors";
import { APIError } from "@/utils/APIError";
import { CommandResult, ServerErrorCode } from "@/types/shared";
import { redactCommand } from "@/utils/redactCommand";

/**
 * Run a command in the container with its payload on stdin.
 *
 * `child_process.exec` passes the whole command as ONE argv string, and Linux
 * caps a single argument at MAX_ARG_STRLEN - 128 KiB. Every file this agent
 * writes used to travel inside that string as base64 (utils/shellWrite.ts), so
 * the clients table stopped fitting at roughly 420 peers and every further
 * create failed with E2BIG while both the node's and the panel's peer caps
 * still reported free slots. Measured on a node: a single argument of 131000
 * bytes runs, 140000 does not.
 *
 * Passing the payload on stdin removes the limit entirely - a pipe has no size
 * cap - and it keeps secrets out of argv, where `ps` on the host and any error
 * message built from the command would otherwise show them.
 *
 * The command itself is still one argv element, but it is now a fixed few
 * hundred bytes regardless of how many peers the node carries.
 */
export const runWithInput = async ({
  container,
  cmd,
  input,
  timeout = 5000,
  maxBufferBytes = 10 * 1024 * 1024,
}: {
  container: string;
  cmd: string;
  input: string;
  timeout?: number;
  maxBufferBytes?: number;
}): Promise<CommandResult> => {
  // Without a container the agent runs the command on its own host, the same
  // way buildCommand() does - this is what the unit tests and a bare-metal
  // install exercise.
  const [file, args] = container
    ? (["docker", ["exec", "-i", container, "sh", "-lc", cmd]] as const)
    : (["sh", ["-lc", cmd]] as const);

  return new Promise<CommandResult>((resolve, reject) => {
    const child = spawn(file, [...args], { stdio: ["pipe", "pipe", "pipe"] });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let killedForOverflow = false;

    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    // Reject on the timeout itself rather than waiting for `close`. `close`
    // fires only once the child has exited AND its stdio pipes are closed, and
    // killing `sh` does not kill what it exec'd - a grandchild inherits those
    // pipes and holds them open. Waiting for `close` therefore means waiting
    // out the very command the timeout was meant to abandon.
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(
            `Command ${redactCommand(cmd)} timed out after ${timeout} ms`,
          ),
        ),
      );
    }, timeout);

    const collect = (into: "stdout" | "stderr") => (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      if (into === "stdout") stdout += text;
      else stderr += text;

      if (stdout.length + stderr.length > maxBufferBytes) {
        killedForOverflow = true;
        child.kill("SIGKILL");
      }
    };

    child.stdout.on("data", collect("stdout"));
    child.stderr.on("data", collect("stderr"));

    // The child can exit before the payload is written - a container that is
    // gone, a shell that fails to start. That closes the pipe and stdin emits
    // EPIPE, which would otherwise be an unhandled error event and take the
    // process down. Swallow it: the exit code and stderr below say what
    // actually went wrong, and they say it far more usefully.
    child.stdin.on("error", () => {});

    child.on("error", (error) => {
      finish(() => reject(toRunError(cmd, error)));
    });

    child.on("close", (code) => {
      finish(() => {
        if (killedForOverflow) {
          return reject(
            new Error(
              `Command ${redactCommand(cmd)} produced more than ${maxBufferBytes} bytes`,
            ),
          );
        }
        if (code !== 0) {
          return reject(toRunError(cmd, stderr || `exit code ${code}`));
        }

        resolve({ stdout, stderr });
      });
    });

    child.stdin.end(input);
  });
};

/**
 * Map a failure onto the same errors `run()` produces, so a caller cannot tell
 * which of the two paths it went through.
 */
const toRunError = (cmd: string, cause: unknown): Error => {
  if (isDockerDaemonUnavailableError(cause)) {
    return new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
      msg: "swagger.errors.DOCKER_NOT_AVAILABLE",
    });
  }
  if (isDockerContainerUnavailableError(cause)) {
    return new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
      msg: "swagger.errors.CONTAINER_NOT_AVAILABLE",
    });
  }

  return new Error(
    `Failed to run command ${redactCommand(cmd)}: ${redactCommand(String(cause))}`,
  );
};
