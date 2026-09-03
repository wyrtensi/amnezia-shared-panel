import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repoRoot = fileURLToPath(new URL("../..", import.meta.url));

/**
 * Directories published with the source. `plans/` and `agent-changes/` are
 * git-ignored and deliberately excluded — deployment detail is allowed to live
 * there and nowhere else.
 */
const PUBLIC_DIRS = ["apps", "packages", "services", "docs", "infra", "scripts"];
const SKIP_DIRS = new Set([
  "node_modules",
  "dist",
  "build",
  ".next",
  "coverage",
]);
const TEXT_FILE = /\.(ts|tsx|mjs|cjs|js|json|md|ya?ml|sh|sql|env\.example)$/;

const walk = (dir, out = []) => {
  for (const entry of readdirSync(dir)) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (TEXT_FILE.test(entry)) out.push(full);
  }
  return out;
};

const files = PUBLIC_DIRS.flatMap((dir) => walk(join(repoRoot, dir)));

/**
 * The walkthrough videos in the connection guide are configured per deployment
 * (`amnezia-panel policy-set --video-<audience>=…`) and stored in the panel's
 * own database. A real Drive file id in the source tree would publish one
 * operator's private recording to everyone who clones the repo.
 *
 * Test fixtures may use the documented placeholder id, which is not a real
 * file.
 */
const DRIVE_FILE = /drive\.google\.com\/(?:file\/d\/|open\?id=)([A-Za-z0-9_-]+)/g;
const PLACEHOLDER = /^1Example/;

test("no Google Drive file link leaks into the published source", () => {
  const offenders = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const match of text.matchAll(DRIVE_FILE)) {
      const id = match[1];
      if (PLACEHOLDER.test(id)) continue;
      offenders.push(`${relative(repoRoot, file)}: ${id}`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    "Drive links are per-deployment settings — configure them with " +
      "`policy-set --video-<audience>=…`, do not commit them:\n" +
      offenders.join("\n"),
  );
});

test("the guard would catch a real-looking id", () => {
  // Guards that cannot fail are worse than no guard, so prove this one bites.
  // Host split out so this file does not match its own pattern.
  const host = "drive.google.com";
  const sample = `https://${host}/file/d/1RealLookingFileId12345/view`;
  const ids = [...sample.matchAll(DRIVE_FILE)].map((match) => match[1]);
  assert.deepEqual(ids, ["1RealLookingFileId12345"]);
  assert.ok(!PLACEHOLDER.test(ids[0]));
});
