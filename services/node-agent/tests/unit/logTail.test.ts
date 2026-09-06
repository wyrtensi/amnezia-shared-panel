import { mkdtemp, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { readLogTail } from "@/utils/logTail";

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "log-tail-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("readLogTail", () => {
  it("returns an empty string for a missing file, without throwing", async () => {
    await expect(readLogTail(join(dir, "missing.log"), 1024)).resolves.toBe("");
  });

  it("returns a file under the cap whole and byte-identical", async () => {
    const path = join(dir, "small.log");
    const content = "pulled\nrecreated\n";
    await writeFile(path, content, "utf8");

    await expect(readLogTail(path, 1024)).resolves.toBe(content);
  });

  it("caps a file over the limit to its last bytes", async () => {
    const path = join(dir, "big.log");
    const content = "y".repeat(2000) + "END";
    await writeFile(path, content, "utf8");

    const result = await readLogTail(path, 1024);

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(1024);
    expect(content.endsWith(result)).toBe(true);
    expect(result.endsWith("END")).toBe(true);
  });

  it("never lands mid-character at a multi-byte boundary", async () => {
    // The leading "a" shifts every following 4-byte emoji off a 4-byte
    // alignment with the cap, so the byte cut is forced to land inside one.
    const maxBytes = 1024;
    const content = "a" + "\u{1F642}".repeat(400); // well over maxBytes in bytes
    const path = join(dir, "emoji.log");
    await writeFile(path, content, "utf8");

    const result = await readLogTail(path, maxBytes);

    expect(Buffer.byteLength(result, "utf8")).toBeLessThanOrEqual(maxBytes);
    expect(result).not.toContain("�");
  });

  it("handles file shrinking between stat and read (mktemp + mv -f scenario)", async () => {
    // When host scripts publish logs atomically via mktemp + mv -f, the file
    // can shrink between our stat() and read() if the new file is smaller.
    // The old code would decode the entire allocated buffer, including
    // zero-filled bytes, as if they were actual file content.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require("fs/promises");
    const path = join(dir, "shrinking.log");
    const actualContent = "ERROR";
    const reportedSize = 1024; // stat says file is 1024 bytes

    await writeFile(path, actualContent, "utf8");

    const originalOpen = fs.open;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (fs.open as any) = vi.fn(async (filePath: string, mode: string) => {
      const handle = await originalOpen(filePath, mode);
      const originalStat = handle.stat.bind(handle);

      // Intercept stat to report a larger size
      handle.stat = async () => {
        const stat = await originalStat();
        return { ...stat, size: reportedSize };
      };

      return handle;
    });

    const result = await readLogTail(path, 1024);

    // Result must be exactly "ERROR" with no NUL bytes
    expect(result).toBe(actualContent);
    // NUL bytes appear as null character in string
    expect(result).not.toContain(" ");
    expect(Buffer.byteLength(result, "utf8")).toBe(Buffer.byteLength(actualContent, "utf8"));
  });
});
