import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, stat, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const run = promisify(execFile);

// A file URL pathname is "/C:/..." on Windows; bash needs "C:/...". Git Bash
// accepts that form directly, so normalise once, here (same trick as
// backup-db.test.mjs and add-node.test.mjs).
const scriptFile = (rel) =>
  new URL(rel, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
const bashPath = (value) => value.replace(/\\/g, "/");

const cleanupScript = scriptFile("../cleanup-whitelist-profile.sh");
const fakeDocker = scriptFile("./fake-docker.sh");

const BLACKLIST_SOURCE =
  '{"url":"https://example.com/ipsum.lst","format":"cidr-lines"}';
const WHITELIST_SOURCE =
  '{"url":"https://example.com/whitelist.txt","format":"cidr-lines"}';
const BOTH_PROFILES =
  `[{"profile":"ru_blacklist","sources":[${BLACKLIST_SOURCE}]},` +
  `{"profile":"ru_whitelist","sources":[${WHITELIST_SOURCE}]}]`;
const WHITELIST_ONLY = `[{"profile":"ru_whitelist","sources":[${WHITELIST_SOURCE}]}]`;

/**
 * A host fixture: infra/prod with a compose.yaml and the .env that marks the
 * stack as configured, plus the fake docker's state directory.
 *
 * `keys` are `id|state|email|node|last-job-error` rows exactly as the fake
 * serves them; `sticky` ids accept a revoke but never reach `revoked`, which is
 * how a stuck revoke looks from the script's side.
 */
const fixture = async ({
  keys = [],
  sticky = [],
  enumPresent = true,
  ruleFeeds = BOTH_PROFILES,
  pocApproved = true,
} = {}) => {
  const dir = bashPath(await mkdtemp(path.join(tmpdir(), "wl-cleanup-")));
  const prod = path.join(dir, "infra", "prod");
  const state = path.join(dir, "fake-docker-state");
  await mkdir(prod, { recursive: true });
  await mkdir(state, { recursive: true });
  await writeFile(path.join(prod, "compose.yaml"), "services: {}\n");
  const envLines = ["POSTGRES_PASSWORD=x"];
  if (ruleFeeds !== null) envLines.push(`RULE_FEEDS=${ruleFeeds}`);
  if (pocApproved) envLines.push("RU_WHITELIST_POC_APPROVED=true");
  envLines.push("PANEL_IDENTITY_SECRET=y");
  await writeFile(path.join(prod, ".env"), `${envLines.join("\n")}\n`);
  await writeFile(path.join(state, "keys"), keys.map((k) => `${k}\n`).join(""));
  await writeFile(path.join(state, "enum"), enumPresent ? "1\n" : "0\n");
  await writeFile(path.join(state, "sticky"), sticky.map((id) => `${id}\n`).join(""));
  await writeFile(path.join(state, "calls.log"), "");
  return { dir, prod, state };
};

const cleanup = (fixtureDir, state, args = []) =>
  run("bash", [cleanupScript, ...args], {
    cwd: fixtureDir,
    env: {
      ...process.env,
      DOCKER: `bash ${fakeDocker}`,
      FAKE_DOCKER_STATE: state,
      POLL_SECONDS: "0",
    },
  });

const callsOf = async (state) =>
  (await readFile(path.join(state, "calls.log"), "utf8"))
    .split("\n")
    .filter(Boolean);

const envOf = async (prod) => readFile(path.join(prod, ".env"), "utf8");

const KEY_A = "11111111-1111-1111-1111-111111111111";
const KEY_B = "22222222-2222-2222-2222-222222222222";

test("without --confirm it reports the blockers and changes nothing", async () => {
  const { dir, prod, state } = await fixture({
    keys: [`${KEY_A}|active|someone@example.com|node-1|-`],
  });
  const before = await envOf(prod);

  const { stdout } = await cleanup(dir, state);

  assert.match(stdout, /block migration 0035/);
  assert.match(stdout, new RegExp(KEY_A));
  assert.match(stdout, /RULE_FEEDS still lists ru_whitelist/);
  assert.match(stdout, /RU_WHITELIST_POC_APPROVED is still set/);
  assert.deepEqual(await callsOf(state), []);
  assert.equal(await envOf(prod), before);
});

test("--confirm revokes every key, then purges it, in that order", async () => {
  const { dir, state } = await fixture({
    keys: [
      `${KEY_A}|active|someone@example.com|node-1|-`,
      `${KEY_B}|revoking|other@example.com|node-2|Node-agent request failed with status 404`,
    ],
  });

  await cleanup(dir, state, ["--confirm"]);

  // Both revokes precede both purges: the API refuses to purge a key the node
  // has not confirmed, so a per-key revoke-then-purge would be a race.
  assert.deepEqual(await callsOf(state), [
    `key-revoke ${KEY_A}`,
    `key-revoke ${KEY_B}`,
    `key-purge ${KEY_A}`,
    `key-purge ${KEY_B}`,
  ]);
  const remaining = await readFile(path.join(state, "keys"), "utf8");
  assert.equal(remaining.trim(), "");
});

test("a key that never reaches revoked is left alone, with its job error", async () => {
  const { dir, state } = await fixture({
    keys: [
      `${KEY_A}|active|someone@example.com|node-1|-`,
      `${KEY_B}|revoking|other@example.com|node-2|Node-agent request failed with status 404`,
    ],
    sticky: [KEY_B],
  });

  const failure = await cleanup(dir, state, ["--confirm", "--timeout=0"]).then(
    () => null,
    (error) => error,
  );

  assert.ok(failure, "expected a non-zero exit while a key is still not revoked");
  assert.match(failure.stderr, new RegExp(KEY_B));
  assert.match(failure.stderr, /status 404/);
  assert.match(failure.stderr, /upgrade to v0\.9\.35 first/);
  // The one that did drain is gone; the stuck one keeps the row that is the
  // only thing still able to find its peer.
  const remaining = await readFile(path.join(state, "keys"), "utf8");
  assert.match(remaining, new RegExp(KEY_B));
  assert.doesNotMatch(remaining, new RegExp(KEY_A));
  assert.ok(!(await callsOf(state)).includes(`key-purge ${KEY_B}`));
});

test("--confirm drops the whitelist feed and keeps the rest, after a backup", async () => {
  const { dir, prod, state } = await fixture({ keys: [] });

  await cleanup(dir, state, ["--confirm"]);

  const env = await envOf(prod);
  assert.match(env, /^RULE_FEEDS=/m);
  assert.doesNotMatch(env, /ru_whitelist/);
  assert.doesNotMatch(env, /RU_WHITELIST_POC_APPROVED/);
  // The blacklist half survives verbatim — this is an operator's own feed list,
  // not something to rewrite wholesale.
  const feeds = JSON.parse(
    env.split("\n").find((line) => line.startsWith("RULE_FEEDS=")).slice("RULE_FEEDS=".length),
  );
  assert.deepEqual(feeds, [
    {
      profile: "ru_blacklist",
      sources: [{ url: "https://example.com/ipsum.lst", format: "cidr-lines" }],
    },
  ]);
  // Untouched neighbours stay.
  assert.match(env, /^PANEL_IDENTITY_SECRET=y$/m);

  const backups = (await readdir(prod)).filter((name) => name.startsWith(".env.bak-"));
  assert.equal(backups.length, 1, "expected exactly one timestamped backup");
  assert.match(await readFile(path.join(prod, backups[0]), "utf8"), /ru_whitelist/);
});

test("it refuses when ru_whitelist is the only profile, rather than choosing for the operator", async () => {
  const { dir, prod, state } = await fixture({ keys: [], ruleFeeds: WHITELIST_ONLY });
  const before = await envOf(prod);

  const failure = await cleanup(dir, state, ["--confirm"]).then(
    () => null,
    (error) => error,
  );

  assert.ok(failure, "expected a non-zero exit rather than a guess");
  assert.match(failure.stderr, /only profile in RULE_FEEDS/);
  assert.equal(await envOf(prod), before, ".env must be untouched when it refuses");
  assert.deepEqual(
    (await readdir(prod)).filter((name) => name.startsWith(".env.bak-")),
    [],
    "a refusal should not leave a backup behind either",
  );
});

test("after migration 0035 it says so and still cleans the environment", async () => {
  const { dir, prod, state } = await fixture({ keys: [], enumPresent: false });

  const { stdout } = await cleanup(dir, state, ["--confirm"]);

  assert.match(stdout, /migration 0035 has already run here/);
  assert.deepEqual(await callsOf(state), []);
  assert.doesNotMatch(await envOf(prod), /ru_whitelist/);
});

// The shape one of the two live panels actually has: whitelist keys in the
// database, but an .env that never named the profile. The environment half must
// be a clean no-op there rather than an error or an empty rewrite.
test("an .env that never named the profile is left exactly as it is", async () => {
  const { dir, prod, state } = await fixture({
    keys: [`${KEY_A}|revoking|someone@example.com|node-1|-`],
    ruleFeeds: null,
    pocApproved: false,
  });
  const before = await envOf(prod);

  const { stdout } = await cleanup(dir, state, ["--confirm"]);

  assert.match(stdout, /Nothing to clean/);
  assert.equal(await envOf(prod), before);
  assert.deepEqual(
    (await readdir(prod)).filter((name) => name.startsWith(".env.bak-")),
    [],
    "nothing to clean means nothing to back up",
  );
  // The key half still ran.
  assert.deepEqual(await callsOf(state), [
    `key-revoke ${KEY_A}`,
    `key-purge ${KEY_A}`,
  ]);
});

test("the cleaned .env keeps the mode it had", async () => {
  const { dir, prod, state } = await fixture({ keys: [] });
  const envFile = path.join(prod, ".env");
  const before = (await stat(envFile)).mode;

  await cleanup(dir, state, ["--confirm"]);

  assert.equal((await stat(envFile)).mode, before);
});
