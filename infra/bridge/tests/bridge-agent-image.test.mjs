import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";

const read = (relative) => readFile(fileURLToPath(new URL(relative, import.meta.url)), "utf8");

test("the Dockerfile pins its bases, runs non-root by default and ships package.json next to dist", async () => {
  const dockerfile = await read("../../../services/bridge-agent/Dockerfile");
  const froms = dockerfile.match(/^FROM .*$/gm) ?? [];
  assert.ok(froms.length >= 3);
  for (const from of froms) assert.match(from, /@sha256:[0-9a-f]{64}/, from);
  assert.match(dockerfile, /^USER 10001$/m);
  assert.match(dockerfile, /COPY --from=build \/app\/dist \.\/dist/);
  assert.match(dockerfile, /^COPY package\.json \.\/$/m);
  assert.match(dockerfile, /npm ci --omit=dev/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/healthz/);
  assert.match(dockerfile, /CMD \["node", "dist\/main\.js"\]/);
});

test("the API version label equals the agent's BRIDGE_API_VERSION and the panel's label name", async () => {
  const dockerfile = await read("../../../services/bridge-agent/Dockerfile");
  const types = await read("../../../services/bridge-agent/src/types.ts");
  const contracts = await read("../../../packages/contracts/src/bridges.ts");
  const version = /BRIDGE_API_VERSION = (\d+);/.exec(types)?.[1];
  assert.ok(version);
  assert.match(dockerfile, new RegExp(`LABEL io\\.amnezia\\.bridge-agent\\.api-version="${version}"`));
  assert.match(contracts, /BRIDGE_AGENT_API_VERSION_LABEL = "io\.amnezia\.bridge-agent\.api-version"/);
  assert.match(contracts, new RegExp(`BRIDGE_AGENT_SUPPORTED_API_VERSIONS: readonly number\\[\\] = \\[${version}\\]`));
});

test("the compose contract the image must satisfy is unchanged: root, no capabilities, read-only", async () => {
  const compose = await read("../compose.yaml");
  assert.match(compose, /user: "0:0"/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /network_mode: host/);
});

test("the release workflow publishes on its own tag, by digest, never as latest", async () => {
  const workflow = await read("../../../.github/workflows/release-bridge-agent.yml");
  const nodeWorkflow = await read("../../../.github/workflows/release-node-agent.yml");
  assert.match(workflow, /tags: \["bridge-agent-v\*"\]/);
  assert.match(workflow, /workflow_dispatch:/);
  assert.match(workflow, /context: services\/bridge-agent/);
  assert.match(workflow, /tags: ghcr\.io\/\$\{\{ github\.repository \}\}\/bridge-agent:\$\{\{ steps\.version\.outputs\.value \}\}/);
  assert.doesNotMatch(workflow, /:latest/);
  // The tag must name the package.json version, or the image misreports itself.
  assert.match(workflow, /package\.json'\)\.version/);
  assert.match(workflow, /does not match services\/bridge-agent\/package\.json/);
  // Same permissions and pushing conditions as the node-agent workflow.
  for (const shared of ["packages: write", "contents: read", "push: true", "platforms: linux/amd64", "uses: docker/login-action@v4", "uses: docker/build-push-action@v7"]) {
    assert.ok(workflow.includes(shared), shared);
    assert.ok(nodeWorkflow.includes(shared), `node-agent workflow lost ${shared}`);
  }
  assert.doesNotMatch(workflow, /softprops|gh release|create-release/);
});

test("CI builds the bridge-agent image on every branch push", async () => {
  const ci = await read("../../../.github/workflows/ci.yml");
  assert.match(ci, /docker build services\/bridge-agent/);
});
