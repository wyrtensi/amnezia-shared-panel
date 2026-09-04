import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const composeUrl = new URL("../compose.yaml", import.meta.url);
const envExampleUrl = new URL("../.env.example", import.meta.url);
const compose = await readFile(composeUrl, "utf8");
const envExample = await readFile(envExampleUrl, "utf8");

const nodeAgentService = compose.slice(
  compose.indexOf("  node-agent:"),
  compose.indexOf("\nvolumes:"),
);

test("the probe can read a real site's response headers", async () => {
  // Node's default is 16 KiB and gemini.google.com answers with more, so every
  // probe against it failed with UND_ERR_HEADERS_OVERFLOW - measured on a live
  // node. It surfaced as an honest `error` rather than a false "blocked", so
  // nobody was misled, but the check could never succeed anywhere.
  assert.match(
    nodeAgentService,
    /--max-http-header-size=\$\{NODE_AGENT_MAX_HEADER_BYTES:-65536\}/,
  );
});

test("the agent's heap is bounded, not sized from host memory", async () => {
  // Unset, V8 picks its old-space limit from the host: measured 1006 MiB on a
  // 2 GiB node, and it would be ~480 MiB on a 1 GiB one - on a host shared
  // with the data plane and sometimes with the panel.
  assert.match(
    nodeAgentService,
    /--max-old-space-size=\$\{NODE_AGENT_MAX_OLD_SPACE_MB:-192\}/,
  );
});

test("the container ceiling and the engine setting move together", async () => {
  // A mem_limit without the engine setting is a delayed OOM kill, not a
  // ceiling: V8 keeps growing towards ITS limit and the cgroup kills the
  // process before it ever collects hard. Both, or neither.
  const hasLimit = /mem_limit: \$\{NODE_AGENT_MEM_LIMIT:-(\d+)m\}/.exec(nodeAgentService);
  const hasHeap = /--max-old-space-size=\$\{NODE_AGENT_MAX_OLD_SPACE_MB:-(\d+)\}/.exec(
    nodeAgentService,
  );
  assert.ok(hasLimit, "node-agent must declare a memory ceiling");
  assert.ok(hasHeap, "node-agent must declare an old-space bound");
  const limitMib = Number(hasLimit[1]);
  const heapMib = Number(hasHeap[1]);
  // The non-heap part of this process measures ~40 MiB (fresh RSS 45 MiB with
  // a 4.4 MiB heap). The gap has to cover that, or a full heap is an OOM kill.
  assert.ok(
    limitMib - heapMib >= 96,
    `ceiling ${limitMib} MiB leaves only ${limitMib - heapMib} MiB above the heap bound`,
  );
});

test("the data plane is deliberately left uncapped", async () => {
  // amneziawg-go allocates per-peer queues, and the measured figures (10 and
  // 26 MiB) come from nodes carrying one and two peers. A ceiling guessed from
  // those would be an OOM kill of the data plane at some peer count nobody has
  // measured - and that is a tunnel outage, not a restart.
  const awg3 = compose.slice(compose.indexOf("  awg3:"), compose.indexOf("  node-agent:"));
  assert.doesNotMatch(awg3, /mem_limit:/);
});

test("both knobs are documented where an operator sets them", async () => {
  assert.match(envExample, /NODE_AGENT_MEM_LIMIT/);
  assert.match(envExample, /NODE_AGENT_MAX_OLD_SPACE_MB/);
});
