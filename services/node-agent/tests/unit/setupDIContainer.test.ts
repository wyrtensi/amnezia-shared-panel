import { mkdtemp, rm } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import type { AwilixContainer } from "awilix";
import type { AgentUpdateService } from "@/services/server/agentUpdate.service";
import type { CapacityService } from "@/services/server/capacity.service";

const REPO = "ghcr.io/owner/repo/node-agent";

let container: AwilixContainer;
let updateSpool = "";
let capacitySpool = "";
let agentUpdateKey = "";
let capacityKey = "";

/**
 * The container is the path production takes: every handler resolves its service
 * by key, per request. Every other suite builds services with `new`, so nothing
 * covered it - and 1.1.8 shipped a constructor awilix's CLASSIC mode could not
 * parse, answering 500 on both /server/update routes on every node.
 */
beforeAll(async () => {
  updateSpool = await mkdtemp(join(tmpdir(), "di-agent-update-"));
  capacitySpool = await mkdtemp(join(tmpdir(), "di-capacity-"));

  // appConfig reads process.env once, when it is first imported, so the
  // environment has to be in place before the container's modules load.
  vi.stubEnv("NODE_AGENT_UPDATE_REPO", REPO);
  vi.stubEnv("NODE_AGENT_UPDATE_SPOOL", updateSpool);
  vi.stubEnv("NODE_AGENT_CAPACITY_SPOOL", capacitySpool);
  vi.resetModules();

  const { di } = await import("@/config/DIContainer/awilixManager");
  const { setupDIContainer } = await import(
    "@/config/DIContainer/setupDIContainer"
  );
  const services = await import("@/services/server");

  setupDIContainer();

  container = di.container;
  agentUpdateKey = services.AgentUpdateService.key;
  capacityKey = services.CapacityService.key;
});

afterAll(async () => {
  await container.dispose();
  await rm(updateSpool, { recursive: true, force: true });
  await rm(capacitySpool, { recursive: true, force: true });
});

describe("setupDIContainer", () => {
  it("constructs every registration", () => {
    // CLASSIC injection derives dependency names by parsing constructor text,
    // so a service can be perfectly valid TypeScript and still be unresolvable.
    // Resolving all of them is the only place that shows up before production.
    const failures: string[] = [];

    for (const key of Object.keys(container.registrations)) {
      try {
        container.resolve(key);
      } catch (error) {
        failures.push(`${key}: ${(error as Error).message.split("\n")[0]}`);
      }
    }

    expect(failures).toEqual([]);
  });

  it("gives the update service the configuration it was started with", () => {
    const service = container.resolve<AgentUpdateService>(agentUpdateKey);

    // Resolving is not enough. A service the container built without its config
    // answers 501 forever, which the panel renders as "this node was never wired
    // for updates" - a silent failure rather than a visible one.
    expect(service.getRepository()).toBe(REPO);
    expect(service.isAvailable()).toBe(true);
  });

  it("gives the capacity service the spool it was started with", () => {
    const service = container.resolve<CapacityService>(capacityKey);

    expect(service.isAvailable()).toBe(true);
  });
});
