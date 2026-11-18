import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createUpdateController,
  parseAcknowledgementDeadlineSeconds,
} from "./updateController.js";

const VERSION = { version: "1.2.3", commit: "abc", builtAt: "2026-01-01" };

describe("createUpdateController", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "panel-update-"));
  });
  afterEach(async () => {
    await chmod(dir, 0o700);
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

  // root ignores directory modes, so the case cannot be staged under root.
  it.skipIf(process.getuid?.() === 0)(
    "reports disabled when the spool dir is not writable",
    async () => {
      // Docker creates a missing bind-mount source as root, so before
      // install-updater.sh has run the spool exists but control-api (uid 1000)
      // cannot write to it, and nothing on the host would pick a request up.
      await chmod(dir, 0o555);
      const controller = createUpdateController({ spoolDir: dir, version: VERSION });
      const status = await controller.status();
      expect(status.enabled).toBe(false);
      await expect(controller.request("admin@x.io")).rejects.toMatchObject({
        code: "UPDATE_NOT_CONFIGURED",
      });
    },
  );

  it("reports disabled when the spool dir does not exist", async () => {
    const controller = createUpdateController({
      spoolDir: join(dir, "missing"),
      version: VERSION,
    });
    expect((await controller.status()).enabled).toBe(false);
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

  describe("acknowledgement deadline", () => {
    const T0 = Date.parse("2026-03-01T00:00:00.000Z");
    const request = (id: string, requestedAt = new Date(T0).toISOString()) =>
      writeFile(
        join(dir, "request.json"),
        JSON.stringify({ id, requestedAt, requestedBy: "a@x.io" }),
        "utf8",
      );
    const at = (seconds: number) => ({
      spoolDir: dir,
      version: VERSION,
      acknowledgementDeadlineSeconds: 120,
      now: () => T0 + seconds * 1000,
    });

    it("has no acknowledgement without a request", async () => {
      const status = await createUpdateController(at(0)).status();
      expect(status).toMatchObject({
        acknowledgement: null,
        requestAgeSeconds: null,
        diagnosticHint: null,
        running: null,
        acknowledgementDeadlineSeconds: 120,
      });
    });

    it("keeps a fresh queued request pending with its age", async () => {
      await request("r1");
      const status = await createUpdateController(at(119)).status();
      expect(status.acknowledgement).toBe("pending");
      expect(status.requestAgeSeconds).toBe(119);
      expect(status.diagnosticHint).toBeNull();
    });

    it("flags a queued request past the deadline and keeps it for recovery", async () => {
      await request("r1");
      const controller = createUpdateController(at(300));
      const status = await controller.status();
      expect(status.acknowledgement).toBe("unacknowledged");
      expect(status.requestAgeSeconds).toBe(300);
      expect(status.diagnosticHint).toBe("UPDATE_NOT_ACKNOWLEDGED");
      expect(status.pending?.id).toBe("r1");
      // Existing fields are unchanged and the request is not re-queued.
      const again = await controller.request("b@x.io");
      expect(again).toMatchObject({ scheduled: false, alreadyPending: true });
      expect(again.request.id).toBe("r1");
      const onDisk = JSON.parse(
        await readFile(join(dir, "request.json"), "utf8"),
      ) as { id: string };
      expect(onDisk.id).toBe("r1");
    });

    it("acknowledges by matching request id, not by any host record", async () => {
      await request("r2");
      await writeFile(
        join(dir, "started.json"),
        JSON.stringify({ id: "r1", startedAt: new Date(T0).toISOString() }),
        "utf8",
      );
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify({ id: "r1", finishedAt: "x", ok: true, message: "" }),
        "utf8",
      );
      expect((await createUpdateController(at(500)).status()).acknowledgement).toBe(
        "unacknowledged",
      );
      await writeFile(
        join(dir, "started.json"),
        JSON.stringify({ id: "r2", startedAt: new Date(T0).toISOString() }),
        "utf8",
      );
      const status = await createUpdateController(at(500)).status();
      expect(status.acknowledgement).toBe("acknowledged");
      expect(status.diagnosticHint).toBeNull();
    });

    it("treats a result for the request id as acknowledged", async () => {
      await request("r3");
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify({ id: "r3", finishedAt: "x", ok: false, message: "m" }),
        "utf8",
      );
      expect((await createUpdateController(at(900)).status()).acknowledgement).toBe(
        "acknowledged",
      );
    });

    it("reports a host-started update with no result as running, however old", async () => {
      await writeFile(
        join(dir, "started.json"),
        JSON.stringify({ id: "r4", startedAt: new Date(T0).toISOString() }),
        "utf8",
      );
      const status = await createUpdateController(at(86400)).status();
      expect(status.running).toEqual({
        id: "r4",
        startedAt: new Date(T0).toISOString(),
      });
      expect(status.acknowledgement).toBe("acknowledged");
      expect(status.diagnosticHint).toBeNull();
    });

    it("does not call a finished run running", async () => {
      await writeFile(
        join(dir, "started.json"),
        JSON.stringify({ id: "r5", startedAt: "x" }),
        "utf8",
      );
      await writeFile(
        join(dir, "result.json"),
        JSON.stringify({ id: "r5", finishedAt: "x", ok: true, message: "" }),
        "utf8",
      );
      const status = await createUpdateController(at(10)).status();
      expect(status.running).toBeNull();
      expect(status.acknowledgement).toBeNull();
    });

    it("fails closed on a request with an undatable requestedAt", async () => {
      await request("r6", "not a date");
      const status = await createUpdateController(at(1)).status();
      expect(status.acknowledgement).toBe("unacknowledged");
      expect(status.requestAgeSeconds).toBeNull();
    });

    it("reads the deadline from the environment value, falling back to 120", () => {
      expect(parseAcknowledgementDeadlineSeconds("45")).toBe(45);
      expect(parseAcknowledgementDeadlineSeconds(undefined)).toBe(120);
      expect(parseAcknowledgementDeadlineSeconds("0")).toBe(120);
      expect(parseAcknowledgementDeadlineSeconds("soon")).toBe(120);
    });
  });
});
