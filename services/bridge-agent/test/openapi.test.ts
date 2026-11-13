import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { ERROR_CODES, MAX_ERRORS } from "../src/types.js";

const yaml = readFileSync(new URL("../openapi/bridge-agent.v1.yaml", import.meta.url), "utf8");

describe("openapi/bridge-agent.v1.yaml", () => {
  it("lists exactly the served paths", () => {
    expect([...yaml.matchAll(/^ {2}(\/[\w/]+):$/gm)].map((m) => m[1])).toEqual(["/healthz", "/v1/identity", "/v1/status"]);
  });

  it("lists the same error codes and bound as the code", () => {
    const line = /code: \{ type: string, enum: \[(FRPS_[^\]]+)\] \}/.exec(yaml)?.[1] ?? "";
    expect(line.split(", ")).toEqual([...ERROR_CODES]);
    expect(yaml).toContain(`maxItems: ${MAX_ERRORS}`);
  });
});
