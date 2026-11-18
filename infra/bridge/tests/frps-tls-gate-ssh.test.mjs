import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../frps-tls-gate-ssh.sh", import.meta.url));

test("uses one pinned SSH identity and passes the verifier token through stdin", { skip: process.platform !== "linux" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "frps-gate-"));
  try {
    const key = join(dir, "key");
    const knownHosts = join(dir, "known_hosts");
    const calls = join(dir, "calls");
    for (const file of [key, knownHosts]) await writeFile(file, "fixture\n", { mode: 0o600 });
    await writeFile(join(dir, "ssh"), "#!/bin/sh\nprintf '%s\\n' \"$@\" >\"$SSH_TEST_CALLS\"\ncat\n", { mode: 0o700 });
    const run = (...args) => spawnSync("sh", [script, ...args], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        SSH_TEST_CALLS: calls,
        BRIDGE_TLS_GATE_REMOTE: "gate@verifier.example.invalid",
        BRIDGE_TLS_GATE_PORT: "2222",
        BRIDGE_TLS_GATE_IDENTITY: key,
        BRIDGE_TLS_GATE_KNOWN_HOSTS: knownHosts,
      },
      input: "bounded verifier token\n",
      encoding: "utf8",
    });
    const rejected = run("verify", "bad value");
    assert.equal(rejected.status, 2, rejected.stderr);
    assert.equal(run("verify", "2026-11-18T12:00:19.1234Z").status, 2);
    await assert.rejects(readFile(calls), { code: "ENOENT" });
    const since = "2026-11-18T12:00:19Z";
    const verified = run("verify", since);
    assert.equal(verified.status, 0, verified.stderr);
    assert.equal(verified.stdout, "bounded verifier token\n");
    const args = (await readFile(calls, "utf8")).trimEnd().split("\n");
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes(`UserKnownHostsFile=${knownHosts}`));
    assert.ok(args.includes(key));
    assert.deepEqual(args.slice(-5), ["-p", "2222", "gate@verifier.example.invalid", "verify", since]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
