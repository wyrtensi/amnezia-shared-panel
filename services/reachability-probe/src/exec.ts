import { execFile } from "node:child_process";

export type ExecResult = { code: number; stdout: string; stderr: string };

export type Exec = (
  cmd: string,
  args: string[],
  opts?: { timeoutMs?: number; input?: string },
) => Promise<ExecResult>;

const DEFAULT_TIMEOUT_MS = 10_000;

const childEnv = (): NodeJS.ProcessEnv => {
  // amneziawg-go hands its own stdout/stderr to the daemon it forks when
  // LOG_LEVEL is set, so execFile would wait for those pipes until timeout.
  const { LOG_LEVEL: _ignored, ...env } = process.env;
  return env;
};

/**
 * Run a binary with arguments, never through a shell. Always resolves: a
 * missing binary, a timeout or a signal becomes a non-zero `code`.
 */
export const execFileExec: Exec = (cmd, args, opts = {}) =>
  new Promise((resolve) => {
    const child = execFile(
      cmd,
      args,
      {
        timeout: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        killSignal: "SIGKILL",
        maxBuffer: 1024 * 1024,
        encoding: "utf8",
        env: childEnv(),
        shell: false,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve({ code: 0, stdout, stderr });
          return;
        }
        const code =
          typeof error.code === "number" ? error.code : error.killed || error.signal ? 124 : 127;
        resolve({ code, stdout: stdout ?? "", stderr: stderr || error.message });
      },
    );
    child.stdin?.on("error", () => {});
    child.stdin?.end(opts.input ?? "");
  });
