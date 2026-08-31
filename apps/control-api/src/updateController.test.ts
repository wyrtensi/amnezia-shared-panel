import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createUpdateController } from "./updateController.js";

const VERSION = { version: "1.2.3", commit: "abc", builtAt: "2026-01-01" };

describe("createUpdateController", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panel-update-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reports disabled when no spool dir is configured", async () => {
    const controller = createUpdateController({ spoolDir: null, version: VERSION });
    const status = await controller.status();
    expect(status.enabled).toBe(false);
    expect(status.version).toEqual(VERSION);
    await expect(controller.request("admin@x.io")).rejects.toMatchObject({
      code: "UPDATE_NOT_CONFIGURED",
    });
  });

  it("writes an atomic request file and reports it as pending", async () => {
    const controller = createUpdateController({ spoolDir: dir, version: VERSION });
    const result = await controller.request("Admin@X.io");
    expect(result.scheduled).toBe(true);
    expect(result.alreadyPending).toBe(false);
    expect(result.request.requestedBy).toBe("Admin@X.io");

    // Persisted where the host worker looks, with no leftover temp file.
    const onDisk = JSON.parse(
      await readFile(join(dir, "request.json"), "utf8"),
    ) as { id: string };
    expect(onDisk.id).toBe(result.request.id);

    const status = await controller.status();
    expect(status.enabled).toBe(true);
    expect(status.pending?.id).toBe(result.request.id);
  });

  it("does not stack a second request while one is pending", async () => {
    const controller = createUpdateController({ spoolDir: dir, version: VERSION });
    const first = await controller.request("a@x.io");
    const second = await controller.request("b@x.io");
    expect(second.scheduled).toBe(false);
    expect(second.alreadyPending).toBe(true);
    // Still the first request — the second caller did not overwrite it.
    expect(second.request.id).toBe(first.request.id);
    expect(second.request.requestedBy).toBe("a@x.io");
  });

  it("surfaces the host worker's result file", async () => {
    const controller = createUpdateController({ spoolDir: dir, version: VERSION });
    await writeFile(
      join(dir, "result.json"),
      JSON.stringify({
        id: "run-1",
        finishedAt: "2026-02-02T00:00:00.000Z",
        ok: true,
        message: "updated to 1.2.3",
      }),
      "utf8",
    );
    const status = await controller.status();
    expect(status.lastResult).toMatchObject({ id: "run-1", ok: true });
  });

  it("treats a corrupt request file as no pending request", async () => {
    const controller = createUpdateController({ spoolDir: dir, version: VERSION });
    await writeFile(join(dir, "request.json"), "not json", "utf8");
    const status = await controller.status();
    expect(status.pending).toBeNull();
  });
});
