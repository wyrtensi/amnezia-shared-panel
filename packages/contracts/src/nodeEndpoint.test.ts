import { describe, expect, it } from "vitest";
import { createKeyRequestSchema, updateNodeRequestSchema } from "./index.js";

const nodeId = "c0d2b125-0a96-479c-9a46-38e32dd86d70";
const endpointId = "64b36c19-e1b3-4f5c-9ca4-87832af3ce32";

describe("node listener selection", () => {
  it("keeps the chosen listener in an AWG 3.1 key request", () => {
    expect(createKeyRequestSchema.parse({ nodeId, endpointId }).endpointId).toBe(endpointId);
  });

  it("rejects listener selection for legacy AWG 2 keys", () => {
    expect(createKeyRequestSchema.safeParse({ nodeId, endpointId, protocol: "awg2" }).success)
      .toBe(false);
  });

  it("accepts a standalone update of a listener name", () => {
    const publicEndpoint = { action: "update", id: endpointId, name: "Second link" };
    expect(updateNodeRequestSchema.parse({ publicEndpoint })).toEqual({ publicEndpoint });
  });

  it("rejects a private listener destination", () => {
    const publicEndpoint = { action: "add", address: "127.0.0.1" };
    expect(updateNodeRequestSchema.safeParse({ publicEndpoint }).success).toBe(false);
  });
});
