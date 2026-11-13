import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({ onRequestMiss: undefined as undefined | (() => void) }));

// The host writes a result and then removes the request. Simulate that landing
// between the agent's result read and its request read.
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    openSync: ((path: string, ...rest: unknown[]) => {
      if (typeof path === "string" && path.includes("/requests/")) hooks.onRequestMiss?.();
      return (actual.openSync as (...a: unknown[]) => number)(path, ...rest);
    }) as typeof actual.openSync,
  };
});

import { readUpdate, spoolOf } from "../src/update.js";

const OP = "0b6f9a52-3c1d-4e7a-9b88-1f2a3c4d5e6f";
let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bridge-agent-race-"));
  const spool = spoolOf(root);
  mkdirSync(spool.requestsDir);
  mkdirSync(spool.resultsDir);
});
afterEach(() => {
  hooks.onRequestMiss = undefined;
  rmSync(root, { recursive: true, force: true });
});

describe("readUpdate lookup race", () => {
  it("re-reads the result after a request miss instead of answering unknown", () => {
    const spool = spoolOf(root);
    hooks.onRequestMiss = () => {
      writeFileSync(
        join(spool.resultsDir, `${OP}.json`),
        JSON.stringify({ operationId: OP, state: "succeeded", updatedAt: "2026-11-13T12:00:30Z" }),
      );
    };
    expect(readUpdate(spool, OP, new Date("2026-11-13T12:01:00Z"))).toEqual({
      operationId: OP,
      state: "succeeded",
      updatedAt: "2026-11-13T12:00:30Z",
    });
  });

  it("is still undefined when nothing ever existed", () => {
    expect(readUpdate(spoolOf(root), OP, new Date())).toBeUndefined();
  });
});
