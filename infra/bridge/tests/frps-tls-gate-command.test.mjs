import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../frps-tls-gate-command.sh", import.meta.url));
const bridge = "00000000-0000-4000-8000-000000000001";
const iso = "2026-11-18T12:00:00.123Z";

test("the forced command only accepts a fixed bridge and a bounded verification verb", { skip: process.platform !== "linux" }, () => {
  const dir = mkdtempSync(resolve(tmpdir(), "frps-gate-"));
  try {
    const cli = resolve(dir, "amnezia-panel");
    writeFileSync(cli, "#!/bin/sh\nprintf '%s\\n' \"$@\"\ncat\n", { mode: 0o700 });
    const run = (original, pinned = bridge, input = "") => spawnSync("sh", [script, pinned], {
      env: { ...process.env, PATH: `${dir}${delimiter}${process.env.PATH}`, SSH_ORIGINAL_COMMAND: original },
      input,
      encoding: "utf8",
    });
    const baseline = run("baseline");
    assert.equal(baseline.status, 0, baseline.stderr);
    assert.equal(baseline.stdout, `bridge-tls-gate\n${bridge}\nbaseline\n`);
    const verify = run(`verify ${iso}`, bridge, "token\n");
    assert.equal(verify.status, 0, verify.stderr);
    assert.equal(verify.stdout, `bridge-tls-gate\n${bridge}\nverify\n${iso}\ntoken\n`);
    for (const rejected of ["", "baseline extra", "baseline\nverify", `verify ${iso};id`, `verify ${iso} --timeout-sec=300`, "verify ../../key"]) {
      assert.notEqual(run(rejected).status, 0, rejected);
    }
    assert.notEqual(run("baseline", "--url=elsewhere").status, 0);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
