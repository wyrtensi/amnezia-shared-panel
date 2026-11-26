import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ execFile: execFileMock }));

import { listRunningDockerContainers } from "@/helpers/docker";

describe("listRunningDockerContainers", () => {
  beforeEach(() => {
    execFileMock.mockReset();
  });

  it("invokes execFile('docker', ['ps', ...]) directly and returns trimmed names", async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, cb: unknown) => {
        const callback = cb as (
          e: Error | null,
          res: { stdout: string; stderr: string },
        ) => void;
        callback(null, {
          stdout: "amnezia-awg3\n amnezia-node-agent \n\n",
          stderr: "",
        });
        return undefined;
      },
    );

    const containers = await listRunningDockerContainers();

    expect(execFileMock).toHaveBeenCalledWith(
      "docker",
      ["ps", "--format", "{{.Names}}"],
      expect.objectContaining({ timeout: 5_000, maxBuffer: 1024 * 1024 }),
      expect.any(Function),
    );
    expect(containers).toEqual(new Set(["amnezia-awg3", "amnezia-node-agent"]));
  });

  it("returns an empty set when docker ps fails", async () => {
    execFileMock.mockImplementation(
      (_file: string, _args: string[], _options: unknown, cb: unknown) => {
        const callback = cb as (
          e: Error,
          res: { stdout: string; stderr: string },
        ) => void;
        callback(new Error("timed out"), { stdout: "", stderr: "" });
        return undefined;
      },
    );

    const containers = await listRunningDockerContainers();

    expect(containers).toEqual(new Set());
  });
});
