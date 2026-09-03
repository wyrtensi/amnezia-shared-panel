import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

// Windows checkouts may carry CRLF; the CI job runs on Linux with LF.
const script = (
  await readFile(new URL("../scripts/deploy.sh", import.meta.url), "utf8")
).replace(/\r\n/g, "\n");
/** Comments describe the very constructs these tests forbid. */
const code = script
  .split("\n")
  .filter((line) => !line.trimStart().startsWith("#"))
  .join("\n");

test("the health gates follow the services this node defines", () => {
  // AWG 3.1 alone is a supported node shape, and a node with no legacy peers
  // has no awg2 service at all. An unconditional `wait_healthy amnezia-awg2`
  // made deploy.sh permanently unusable on such a node: it recreated the
  // containers, then failed a gate for a protocol the node does not serve.
  assert.doesNotMatch(code, /^if ! wait_healthy amnezia-awg2/m);
  assert.match(code, /has_service awg2 && ! wait_healthy amnezia-awg2/);
  assert.match(code, /has_service awg3 && ! wait_healthy amnezia-awg3/);
});

test("the AWG images are only pulled for services this node defines", () => {
  // Same reason, one step earlier: pulling and verifying an image for a
  // service that is not deployed here is work that can only fail.
  assert.match(code, /has_service awg2; then\n\s+docker pull[^\n]*AWG2_IMAGE/);
  assert.match(code, /has_service awg3; then\n\s+docker pull[^\n]*AWG3_IMAGE/);
});

test("the node-agent gate stays unconditional", () => {
  // Every node runs the agent; there is no shape where it is optional.
  assert.match(code, /^if ! wait_healthy amnezia-node-agent/m);
});
