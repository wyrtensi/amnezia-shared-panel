import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const preflightUrl = new URL("../scripts/preflight.sh", import.meta.url);
const script = await readFile(preflightUrl, "utf8");
/** Comments quote the very constructs some of these tests forbid. */
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

test("the API key charset check stays linear in the key length", async () => {
  // `grep -E '^[[:graph:]]{32,4096}$'` expands the bounded interval into an
  // automaton costing ~280 MB RSS and ~20 s on one vCPU (measured, GNU grep
  // 3.11). On a small node the OOM killer reaps it and the script then blames
  // a perfectly valid key.
  assert.doesNotMatch(code, /\[\[:graph:\]\]\{/);
  assert.match(code, /tr -d '\[:graph:\]'/);
});

test("the RAM gate names the lever that lowers it", async () => {
  const gate = code.slice(
    code.indexOf("required_mem_kb="),
    code.indexOf("forbidden_found=0"),
  );
  // The gate scales with declared capacity, and the template ships the 500-peer
  // maximum — so an operator who hits this needs to be told that lowering
  // SERVER_MAX_PEERS is the supported response, not just what the number is.
  assert.match(gate, /SERVER_MAX_PEERS/);
});

test("the disk gate says how to reclaim the space it wants", async () => {
  const gate = code.slice(code.indexOf("available_kb="), code.indexOf("available_mem_kb="));
  // Free space is the constraint that actually binds on a small host, and it is
  // almost always reclaimable rather than absent.
  assert.match(gate, /docker image prune/);
  assert.match(gate, /journalctl --vacuum-size/);
});
