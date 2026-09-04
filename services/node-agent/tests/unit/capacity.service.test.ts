import { mkdtemp, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CapacityService } from "@/services/server/capacity.service";

let spoolDir = "";

beforeEach(async () => {
  spoolDir = await mkdtemp(join(tmpdir(), "capacity-spool-"));
});

afterEach(async () => {
  await rm(spoolDir, { recursive: true, force: true });
});

const service = () => new CapacityService({ spoolDir });

const readSpool = async (name: string) =>
  JSON.parse(await readFile(join(spoolDir, name), "utf8"));

describe("CapacityService availability", () => {
  it("is off when no spool is configured, and says so instead of throwing", async () => {
    const off = new CapacityService({ spoolDir: "" });

    expect(off.isAvailable()).toBe(false);
    // A node that cannot change its own capacity must still answer: to the
    // panel, a 500 here is indistinguishable from a node that is down.
    await expect(off.getStatus()).resolves.toMatchObject({
      state: "idle",
      requestedMaxPeers: null,
    });
  });

  it("refuses a request when the feature is not installed", async () => {
    const off = new CapacityService({ spoolDir: "" });

    await expect(off.requestCapacity(300)).rejects.toMatchObject({
      statusCode: 501,
    });
  });
});

describe("CapacityService.requestCapacity", () => {
  it("writes the trigger and its own copy of the request", async () => {
    const { id, maxPeers } = await service().requestCapacity(300);

    expect(maxPeers).toBe(300);
    // pending is written first on purpose: an agent that dies between the two
    // writes leaves a marker and no trigger, which reads as "running" and
    // resolves when a result appears - never as a request silently dropped.
    expect(await readSpool("pending.json")).toMatchObject({ id, maxPeers: 300 });
    expect(await readSpool("request.json")).toMatchObject({ id, maxPeers: 300 });
  });

  it.each([0, -1, 501, 1.5, Number.NaN])(
    "rejects %s, because the host script would have to re-check it anyway",
    async (value) => {
      await expect(service().requestCapacity(value)).rejects.toMatchObject({
        statusCode: 400,
      });
    },
  );

  // The applier edits .env and recreates a container. Two requests racing would
  // interleave those steps, and the loser would read the winner's result as its
  // own outcome.
  it("refuses a second request while one is still in flight", async () => {
    const capacity = service();
    await capacity.requestCapacity(300);

    await expect(capacity.requestCapacity(400)).rejects.toMatchObject({
      statusCode: 409,
    });
  });
});

describe("CapacityService.getStatus", () => {
  it("reads idle from an empty spool", async () => {
    await expect(service().getStatus()).resolves.toMatchObject({
      state: "idle",
      requestedMaxPeers: null,
      updatedAt: null,
    });
  });

  it("reads requested while the trigger is still there", async () => {
    const capacity = service();
    await capacity.requestCapacity(300);

    await expect(capacity.getStatus()).resolves.toMatchObject({
      state: "requested",
      requestedMaxPeers: 300,
    });
  });

  it("reads running once the applier has taken the trigger", async () => {
    const capacity = service();
    await capacity.requestCapacity(300);
    await rm(join(spoolDir, "request.json"));

    await expect(capacity.getStatus()).resolves.toMatchObject({
      state: "running",
      requestedMaxPeers: 300,
    });
  });

  it("reads succeeded only from a result that matches this request", async () => {
    const capacity = service();
    const { id } = await capacity.requestCapacity(300);
    await rm(join(spoolDir, "request.json"));
    await writeFile(
      join(spoolDir, "result.json"),
      JSON.stringify({
        id,
        ok: true,
        maxPeers: 300,
        finishedAt: "2026-09-04T00:00:00.000Z",
        message: "SERVER_MAX_PEERS=300 applied",
      }),
    );

    await expect(capacity.getStatus()).resolves.toMatchObject({
      state: "succeeded",
      requestedMaxPeers: 300,
      updatedAt: "2026-09-04T00:00:00.000Z",
    });
  });

  // A result left over from an earlier change must not be read as the outcome
  // of this one: that would report success for something still running.
  it("stays running when the only result belongs to an earlier request", async () => {
    const capacity = service();
    await capacity.requestCapacity(300);
    await rm(join(spoolDir, "request.json"));
    await writeFile(
      join(spoolDir, "result.json"),
      JSON.stringify({ id: "some-older-request", ok: true, maxPeers: 100 }),
    );

    await expect(capacity.getStatus()).resolves.toMatchObject({
      state: "running",
      requestedMaxPeers: 300,
    });
  });

  it("reads failed, and carries the applier's message", async () => {
    const capacity = service();
    const { id } = await capacity.requestCapacity(300);
    await rm(join(spoolDir, "request.json"));
    await writeFile(
      join(spoolDir, "result.json"),
      JSON.stringify({
        id,
        ok: false,
        maxPeers: 300,
        finishedAt: "2026-09-04T00:00:00.000Z",
        message: "preflight refused: not enough memory",
      }),
    );

    await expect(capacity.getStatus()).resolves.toMatchObject({
      state: "failed",
      message: "preflight refused: not enough memory",
    });
  });

  // The spool is written by a host-side script this container cannot verify.
  // Anything unparseable is treated as absent rather than crashing the status
  // call, which the panel polls every minute.
  it("treats an unparseable spool file as absent", async () => {
    await writeFile(join(spoolDir, "result.json"), "{ this is not json");
    await writeFile(join(spoolDir, "pending.json"), "neither is this");

    await expect(service().getStatus()).resolves.toMatchObject({
      state: "idle",
    });
  });

  it("keeps only the tail of a large log", async () => {
    await writeFile(join(spoolDir, "apply.log"), "x".repeat(100 * 1024));

    const { log } = await service().getStatus();

    expect(log.length).toBe(64 * 1024);
  });
});
