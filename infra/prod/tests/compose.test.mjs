import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const prodComposeUrl = new URL("../compose.yaml", import.meta.url);
const devComposeUrl = new URL("../../dev/compose.yaml", import.meta.url);

/**
 * Minimal structural reader for these two Compose files. The infra CI job runs
 * `node --test` on a bare checkout with no dependencies installed, so a real
 * YAML parser is not available here.
 *
 * Returns the top-level `x-app` anchor block plus one entry per service, with
 * the anchor text folded into every service that merges it — so a check for a
 * key does not care whether it is written on the service or inherited.
 */
const readCompose = async (url) => {
  const text = await readFile(url, "utf8");
  const lines = text.split("\n");

  const indentOf = (line) => /^ */.exec(line)[0].length;

  /** Every line nested deeper than the mapping key at `startIndex`. */
  const blockFrom = (startIndex) => {
    const headerIndent = indentOf(lines[startIndex]);
    const body = [];
    for (let i = startIndex + 1; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.trim() === "") continue;
      if (indentOf(line) <= headerIndent) break;
      body.push(line);
    }
    return body.join("\n");
  };

  const anchorIndex = lines.findIndex((line) => line.startsWith("x-app:"));
  const anchor = anchorIndex === -1 ? "" : blockFrom(anchorIndex);

  const servicesIndex = lines.findIndex((line) => line === "services:");
  assert.notEqual(servicesIndex, -1, "compose file must declare services");

  const services = new Map();
  for (let i = servicesIndex + 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line.trim() === "") continue;
    if (indentOf(line) === 0) break;
    const name = /^ {2}([A-Za-z][\w-]*):\s*$/.exec(line)?.[1];
    if (!name) continue;
    const own = blockFrom(i);
    services.set(name, own.includes("<<: *app") ? `${own}\n${anchor}` : own);
  }
  return services;
};

test("every production service runs a real init so adopted children are reaped", async () => {
  const services = await readCompose(prodComposeUrl);

  assert.ok(services.size >= 5, "expected the full production stack");
  for (const [name, body] of services) {
    // Without an init as PID 1, the healthcheck's busybox `wget` leaves an
    // orphaned `ssl_client` behind on every interval. Node never reaps it, so
    // the container accumulates one zombie every 10s until its cgroup task
    // budget is exhausted and it can no longer fork.
    assert.match(body, /^\s+init: true$/m, `${name} must set init: true`);
  }
});

test("every production service bounds its own task count", async () => {
  const services = await readCompose(prodComposeUrl);

  for (const [name, body] of services) {
    // Without an explicit limit the container inherits systemd's
    // DefaultTasksMax, which is a percentage of kernel.threads-max and so
    // scales with host RAM — a runaway container eats the whole host's task
    // budget on a small box.
    assert.match(body, /^\s+pids_limit: /m, `${name} must set pids_limit`);
  }
});

test("postgres is sized for the memory ceiling it is given", async () => {
  const services = await readCompose(prodComposeUrl);
  const postgres = services.get("postgres");

  assert.ok(postgres, "the production stack must define postgres");
  // A mem_limit without matching engine settings is a delayed OOM: stock
  // shared_buffers is 128MB against a 192MiB ceiling, and stock
  // max_connections is 100 backends each able to claim work_mem.
  assert.match(postgres, /^\s+mem_limit: /m);
  assert.match(postgres, /shared_buffers=\$\{POSTGRES_SHARED_BUFFERS:-\d+MB\}/);
  assert.match(postgres, /work_mem=\$\{POSTGRES_WORK_MEM:-\d+MB\}/);
  assert.match(postgres, /max_connections=\$\{POSTGRES_MAX_CONNECTIONS:-\d+\}/);
});

test("postgres keeps room for every pool the panel opens", async () => {
  const services = await readCompose(prodComposeUrl);
  const postgres = services.get("postgres");

  // packages/db/src/client.ts opens `max: 10` per process. control-api,
  // worker and a transient migrate run concurrently, and the co-located CLI
  // opens its own — so the floor is 30 plus headroom and the superuser slots.
  const max = Number(
    /max_connections=\$\{POSTGRES_MAX_CONNECTIONS:-(\d+)\}/.exec(postgres)?.[1],
  );
  assert.ok(max >= 40, `max_connections default ${max} is below the pool floor`);
});

test("the dev stack reaps adopted children too", async () => {
  const services = await readCompose(devComposeUrl);

  assert.ok(services.size >= 5, "expected the full dev stack");
  for (const [name, body] of services) {
    assert.match(body, /^\s+init: true$/m, `${name} must set init: true`);
  }
});
