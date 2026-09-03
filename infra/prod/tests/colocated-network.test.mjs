import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/**
 * The panel and a co-located Amnezia node run as two compose projects, so the
 * panel resolves `amnezia-node-agent` only while its containers are attached to
 * the node's network. Doing that by hand (`docker network connect`) is lost the
 * moment the panel stack is recreated — which is exactly how the node went to
 * `lastError = "fetch failed"` in production. These assertions pin the two
 * pieces that make the attachment survive a redeploy.
 */
const overrideExampleUrl = new URL(
  "../compose.override.colocated.yaml.example",
  import.meta.url,
);
const deployScriptUrl = new URL("../../../scripts/deploy.sh", import.meta.url);
const updateScriptUrl = new URL("../update.sh", import.meta.url);

test("deploy.sh loads compose.override.yaml like update.sh does", async () => {
  const deploy = await readFile(deployScriptUrl, "utf8");
  const update = await readFile(updateScriptUrl, "utf8");

  // update.sh has always honoured the override; deploy.sh did not, so a deploy
  // through it silently dropped the co-located network wiring.
  assert.match(update, /compose\.override\.yaml/);
  assert.match(deploy, /compose\.override\.yaml/);
  // The override must reach the compose invocation, not just a comment.
  assert.match(deploy, /COMPOSE="docker compose -f \$\{COMPOSE_DIR\}\/compose\.yaml \$\{OVERRIDE\}"/);
  assert.match(deploy, /^\s*OVERRIDE="-f \$\{COMPOSE_DIR\}\/compose\.override\.yaml"$/m);
});

test("deploy.sh keeps refusing destructive arguments", async () => {
  const deploy = await readFile(deployScriptUrl, "utf8");

  // The override plumbing must not disturb the guard that keeps this script
  // from ever tearing down volumes.
  assert.match(deploy, /down\|-v\|--volumes\|prune\)/);
  assert.match(deploy, /Refusing destructive argument/);
});

test("the co-located example attaches both node-calling services", async () => {
  const example = await readFile(overrideExampleUrl, "utf8");

  // control-api serves admin actions and worker runs provisioning plus the
  // telemetry poll; both call the node-agent directly, so both need the node
  // network. web and postgres never do.
  for (const service of ["control-api", "worker"]) {
    const block = /^ {2}([a-z-]+):\n((?: {4,}.*\n|\n)*)/gm;
    const services = new Map();
    for (const match of example.matchAll(block)) {
      services.set(match[1], match[2]);
    }
    const body = services.get(service);
    assert.ok(body, `the example must override ${service}`);
    assert.match(body, /^\s+networks:$/m, `${service} must declare networks`);
    assert.match(body, /^\s+node: \{\}$/m, `${service} must join the node network`);
    // Compose replaces the service's network set on merge, so the panel network
    // has to be repeated or the service loses postgres and its siblings.
    assert.match(body, /^\s+panel: \{\}$/m, `${service} must keep the panel network`);
  }
});

test("the co-located example declares the node network as external", async () => {
  const example = await readFile(overrideExampleUrl, "utf8");

  const networks = /^networks:\n((?: {2,}.*\n|\n)*)/m.exec(example)?.[1];
  assert.ok(networks, "the example must declare a top-level networks section");
  // The node's compose project owns this network; the panel must never create
  // it, otherwise it silently gets an empty network of its own name.
  assert.match(networks, /^\s+external: true$/m);
  // Overridable name with the stock default of the `amnezia-node` project.
  assert.match(networks, /^\s+name: \$\{NODE_DOCKER_NETWORK:-amnezia-node_default\}$/m);
});

test("the co-located example stays an example, not an active override", async () => {
  const example = await readFile(overrideExampleUrl, "utf8");

  // An `external` network breaks a panel-only host outright, so the file must
  // be opt-in by copy and must say so.
  assert.match(example, /compose\.override\.colocated\.yaml\.example infra\/prod\/compose\.override\.yaml/);
  assert.ok(
    overrideExampleUrl.pathname.endsWith(".example"),
    "the shipped file must not be picked up automatically",
  );
});
