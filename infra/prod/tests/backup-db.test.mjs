import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const scriptUrl = new URL("../../../scripts/backup-db.sh", import.meta.url);

test("dumps are created owner-only, in an owner-only directory, before pg_dump runs", async () => {
  const script = await readFile(scriptUrl, "utf8");

  const umask = script.indexOf("umask 077");
  const mkdir = script.indexOf('mkdir -p "$OUT_DIR"');
  const chmod = script.indexOf('chmod 700 "$OUT_DIR"');
  const dump = script.indexOf("pg_dump");

  assert.ok(umask >= 0, "umask 077 must be set (the dump holds the whole user roster)");
  assert.ok(mkdir >= 0 && dump >= 0, "script layout changed; update this test");
  assert.ok(umask < mkdir, "umask must precede the directory creation so a fresh dir is 0700");
  assert.ok(chmod > mkdir && chmod < dump, "an existing directory must be tightened before the dump lands in it");
});
