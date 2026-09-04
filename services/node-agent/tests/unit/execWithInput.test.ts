import { describe, expect, it } from "vitest";

import { runWithInput } from "@/utils/execWithInput";

/**
 * The wall this module exists to get past. Linux caps a single argv string at
 * MAX_ARG_STRLEN; measured on a node, 131000 bytes runs and 140000 does not.
 */
const MAX_ARG_STRLEN = 128 * 1024;

// These spawn a real `sh`, which a Windows dev box does not have. CI is Linux
// and runs them; skipping locally is honest, whereas mocking child_process here
// would test the mock rather than the thing that used to break.
const onPosix = process.platform === "win32" ? describe.skip : describe;

onPosix("runWithInput", () => {
  it("passes a payload far larger than the argv limit", async () => {
    const payload = "y".repeat(4 * MAX_ARG_STRLEN);

    const { stdout } = await runWithInput({
      container: "",
      cmd: "wc -c",
      input: payload,
      timeout: 15_000,
    });

    expect(payload.length).toBeGreaterThan(MAX_ARG_STRLEN);
    expect(Number(stdout.trim())).toBe(payload.length);
  });

  it("round-trips base64 the way a file write does", async () => {
    const content = "[Interface]\nAddress = 10.89.0.1/22\n";
    const encoded = Buffer.from(content, "utf-8").toString("base64");

    const { stdout } = await runWithInput({
      container: "",
      cmd: "base64 -d",
      input: encoded,
    });

    expect(stdout).toBe(content);
  });

  it("rejects when the command fails, and says what the shell said", async () => {
    await expect(
      runWithInput({
        container: "",
        cmd: "echo 'no such thing' >&2; exit 3",
        input: "",
      }),
    ).rejects.toThrow(/no such thing/);
  });

  it("rejects when the command outruns its timeout", async () => {
    await expect(
      runWithInput({
        container: "",
        cmd: "sleep 5",
        input: "",
        timeout: 100,
      }),
    ).rejects.toThrow(/timed out/);
  });

  // A command that never reads stdin closes the pipe under us. That surfaces as
  // EPIPE on the writable side, which would be an unhandled error event and
  // take the agent down; the failure that matters is the command's own.
  it("survives a command that exits without reading stdin", async () => {
    await expect(
      runWithInput({
        container: "",
        cmd: "exit 0",
        input: "z".repeat(4 * MAX_ARG_STRLEN),
      }),
    ).resolves.toMatchObject({ stdout: "" });
  });
});
