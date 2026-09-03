import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { resolveApiKey, resolveSecret } from "./apiKey.js";

describe("resolveApiKey", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("still accepts the legacy --api-key= value", () => {
    expect(resolveApiKey(["--name=n", "--api-key=abc=def"])).toBe("abc=def");
  });

  it("is undefined when neither flag is given (node-update leaves the key alone)", () => {
    expect(resolveApiKey(["--name=n"])).toBeUndefined();
  });

  it("reads the first line of --api-key-file= and trims it", () => {
    const read = (path: string) => (path === "/run/key" ? "  the-key \nignored\n" : "");
    expect(resolveApiKey(["--api-key-file=/run/key"], read)).toBe("the-key");
  });

  it("reads stdin for --api-key-file=-", () => {
    const read = (path: string) => (path === "-" ? "from-stdin\n" : "");
    expect(resolveApiKey(["--api-key-file=-"], read)).toBe("from-stdin");
  });

  it("rejects an empty file", () => {
    expect(() => resolveApiKey(["--api-key-file=/run/key"], () => "\n")).toThrowError(
      /API key file is empty: \/run\/key/,
    );
  });

  it("rejects both flags at once", () => {
    expect(() => resolveApiKey(["--api-key-file=/run/key", "--api-key=x"])).toThrowError(
      /either --api-key-file= or --api-key=/,
    );
  });

  it("reads a real file with the default reader", () => {
    const dir = mkdtempSync(join(tmpdir(), "cli-api-key-"));
    dirs.push(dir);
    const file = join(dir, "node-agent-api-key");
    writeFileSync(file, "real-key\n", { mode: 0o600 });
    expect(resolveApiKey([`--api-key-file=${file}`])).toBe("real-key");
  });
});

describe("resolveSecret — cf-token", () => {
  it("reads the token from a file", () => {
    expect(resolveSecret(["--token-file=/run/cf"], "token", () => "cfast_x\n")).toBe(
      "cfast_x",
    );
  });
  it("reads the token from stdin", () => {
    expect(resolveSecret(["--token-file=-"], "token", () => "cfast_x\n")).toBe(
      "cfast_x",
    );
  });
  it("rejects an empty token file", () => {
    expect(() => resolveSecret(["--token-file=/run/cf"], "token", () => "\n")).toThrowError(
      /token file is empty/,
    );
  });
  it("rejects both forms at once", () => {
    expect(() => resolveSecret(["--token-file=/run/cf", "--token=x"], "token")).toThrowError(
      /either --token-file= or --token=/,
    );
  });
});
