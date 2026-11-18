import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const script = fileURLToPath(new URL("../frps-tls-issue.sh", import.meta.url));

test("rekeys into separate files using only the configured CA", { skip: process.platform !== "linux" }, async () => {
  const dir = await mkdtemp(join(tmpdir(), "frps-issuer-"));
  try {
    const cert = join(dir, "current.crt");
    const key = join(dir, "current.key");
    const candidateCert = join(dir, "candidate.crt");
    const candidateKey = join(dir, "candidate.key");
    const root = join(dir, "ca.crt");
    const step = join(dir, "step");
    for (const file of [cert, key, root]) await writeFile(file, "fixture\n", { mode: 0o600 });
    await writeFile(step, `#!/bin/sh
printf '%s\\n' "$@" > "$ISSUER_TEST_LOG"
if [ "\${ISSUER_TEST_FAIL:-0}" = 1 ]; then
  echo 'sensitive client error' >&2
  exit 1
fi
for arg in "$@"; do
  case "$arg" in
    --out-cert=*) printf new-cert > "\${arg#*=}" ;;
    --out-key=*) printf new-key > "\${arg#*=}" ;;
  esac
done
`, { mode: 0o700 });
    await chmod(step, 0o700);
    const args = [cert, key, candidateCert, candidateKey];
    const run = (options = {}, inputs = args) => spawnSync("sh", [script, ...inputs], {
      env: {
        ...process.env,
        PATH: `${dir}:${process.env.PATH}`,
        FRPS_TLS_CA_URL: "https://issuer.example.invalid:9000",
        FRPS_TLS_CA_FILE: root,
        ISSUER_TEST_LOG: join(dir, "calls"),
        ...options,
      },
      encoding: "utf8",
    });

    const insecure = run({ FRPS_TLS_CA_URL: "http://issuer.example.invalid" });
    assert.equal(insecure.status, 2, insecure.stderr);
    await assert.rejects(readFile(join(dir, "calls")), { code: "ENOENT" });
    const authInUrl = run({ FRPS_TLS_CA_URL: "https://user:password@issuer.example.invalid" });
    assert.equal(authInUrl.status, 2, authInUrl.stderr);
    assert.doesNotMatch(authInUrl.stderr, /password/);

    const failed = run({ ISSUER_TEST_FAIL: "1" });
    assert.equal(failed.status, 1, failed.stderr);
    assert.doesNotMatch(failed.stderr, /sensitive client error/);
    assert.match(failed.stderr, /issuer/);

    const rotated = run();
    assert.equal(rotated.status, 0, rotated.stderr);
    assert.equal(await readFile(candidateCert, "utf8"), "new-cert");
    assert.equal(await readFile(candidateKey, "utf8"), "new-key");
    assert.equal(await readFile(key, "utf8"), "fixture\n");
    assert.deepEqual((await readFile(join(dir, "calls"), "utf8")).trimEnd().split("\n"), [
      "ca", "rekey", cert, key,
      "--ca-url=https://issuer.example.invalid:9000", `--root=${root}`,
      `--out-cert=${candidateCert}`, `--out-key=${candidateKey}`,
    ]);

    const alias = join(dir, "alias");
    await symlink(join(dir, "missing"), alias);
    assert.equal(run({}, [cert, key, candidateCert, key]).status, 2);
    assert.equal(run({}, [cert, key, alias, join(dir, "new.key")]).status, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
