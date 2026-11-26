import { promisify } from "util";
import { execFile } from "child_process";
import { TimeContract } from "@/contracts/time";

// Promisify execFile so timeouts kill the docker client directly rather than an intermediate shell.
const execFileAsync = promisify(execFile);

/**
 * Return the set of currently running Docker container names.
 * Returns an empty set if Docker is unavailable.
 */
export async function listRunningDockerContainers(): Promise<Set<string>> {
  try {
    const { stdout } = await execFileAsync(
      "docker",
      ["ps", "--format", "{{.Names}}"],
      {
        timeout: 5 * TimeContract.SECOND,
        maxBuffer: 1024 * 1024,
      },
    );

    const names = stdout
      .split("\n")
      .map((x) => x.trim())
      .filter(Boolean);

    return new Set(names);
  } catch {
    return new Set();
  }
}

/**
 * Проверить, запущен ли Docker-контейнер по имени
 */
export async function isDockerContainerRunning(name: string): Promise<boolean> {
  if (!name) return false;

  const containers = await listRunningDockerContainers();

  return containers.has(name);
}
