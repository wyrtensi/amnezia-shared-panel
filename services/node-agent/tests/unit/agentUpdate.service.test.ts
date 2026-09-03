import { mkdtemp, readFile, readdir, rm, symlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isPublishableAgentImage } from "@/utils/agentImage";
import { AgentUpdateService } from "@/services/server/agentUpdate.service";

const REPO = "ghcr.io/owner/repo/node-agent";
const DIGEST = `sha256:${"a".repeat(64)}`;
const IMAGE = `${REPO}@${DIGEST}`;

// The same table the host-side updater re-checks from the spool, and the same
// one packages/contracts pins for the panel. All three must agree: the panel
// only offers what the agent accepts, and the updater trusts neither.
describe("isPublishableAgentImage", () => {
  it("accepts a digest reference for exactly the trusted repository", () => {
    expect(isPublishableAgentImage(IMAGE, REPO)).toBe(true);
  });

  it("rejects a tag, because a tag is mutable", () => {
    expect(isPublishableAgentImage(`${REPO}:1.1.2`, REPO)).toBe(false);
    expect(isPublishableAgentImage(`${REPO}:latest`, REPO)).toBe(false);
  });

  it("rejects another repository, however similar", () => {
    expect(isPublishableAgentImage(`ghcr.io/evil/repo/node-agent@${DIGEST}`, REPO)).toBe(false);
    expect(isPublishableAgentImage(`${REPO}-evil@${DIGEST}`, REPO)).toBe(false);
    expect(isPublishableAgentImage(`evil.io/${REPO}@${DIGEST}`, REPO)).toBe(false);
  });

  it("rejects a bare image id, a malformed digest and a second @", () => {
    expect(isPublishableAgentImage(DIGEST, REPO)).toBe(false);
    expect(isPublishableAgentImage(`${REPO}@sha256:abc`, REPO)).toBe(false);
    expect(isPublishableAgentImage(`${REPO}@sha256:${"A".repeat(64)}`, REPO)).toBe(false);
    expect(isPublishableAgentImage(`${REPO}@${DIGEST}@${DIGEST}`, REPO)).toBe(false);
  });

  it("rejects a scheme, surrounding whitespace and the empty string", () => {
    expect(isPublishableAgentImage(`https://${REPO}@${DIGEST}`, REPO)).toBe(false);
    expect(isPublishableAgentImage(` ${IMAGE}`, REPO)).toBe(false);
    expect(isPublishableAgentImage(`${IMAGE} rm -rf /`, REPO)).toBe(false);
    expect(isPublishableAgentImage("", REPO)).toBe(false);
    expect(isPublishableAgentImage(IMAGE, "")).toBe(false);
  });
});

describe("AgentUpdateService", () => {
  let spool: string;

  beforeEach(async () => {
    spool = await mkdtemp(join(tmpdir(), "agent-update-"));
  });

  afterEach(async () => {
    await rm(spool, { recursive: true, force: true });
  });

  const service = (overrides: { repository?: string; spoolDir?: string } = {}) =>
    new AgentUpdateService({
      repository: overrides.repository ?? REPO,
      spoolDir: overrides.spoolDir ?? spool,
    });

  const readJson = async (name: string) =>
    JSON.parse(await readFile(join(spool, name), "utf8"));

  it("is unavailable until a host is wired for it", async () => {
    // The feature is opt-in: no repository, or no spool mount, means the node
    // simply cannot update itself and the panel must be told so, rather than
    // the request disappearing into a directory nothing watches.
    expect(service({ repository: "" }).isAvailable()).toBe(false);
    expect(service({ spoolDir: "" }).isAvailable()).toBe(false);
    expect(service({ spoolDir: join(spool, "missing") }).isAvailable()).toBe(false);
    expect(service().isAvailable()).toBe(true);
  });

  it("refuses every request with 501 until the host is wired", async () => {
    // 501 and not 400: the reference is fine, the node simply has nothing on
    // the host that would act on it. The panel must be able to tell the two
    // apart, because only one of them is the admin's mistake.
    await expect(service({ repository: "" }).requestUpdate(IMAGE)).rejects.toMatchObject({
      statusCode: 501,
    });
    await expect(
      service({ spoolDir: join(spool, "missing") }).requestUpdate(IMAGE),
    ).rejects.toMatchObject({ statusCode: 501 });
  });

  it("refuses a reference outside the configured repository", async () => {
    await expect(
      service().requestUpdate(`ghcr.io/evil/repo/node-agent@${DIGEST}`),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(await readdir(spool)).toEqual([]);
  });

  it("refuses a tag even inside the configured repository", async () => {
    await expect(service().requestUpdate(`${REPO}:1.1.2`)).rejects.toMatchObject({
      statusCode: 400,
    });

    expect(await readdir(spool)).toEqual([]);
  });

  it("writes exactly one request, plus the pending marker the state needs", async () => {
    const { id } = await service().requestUpdate(IMAGE);

    const request = await readJson("request.json");
    expect(request).toMatchObject({ id, image: IMAGE });
    expect(typeof request.requestedAt).toBe("string");
    // The updater deletes request.json the moment it starts, so on its own it
    // cannot distinguish "running" from "never asked". pending.json is the
    // agent's own copy and survives the restart the update causes.
    expect(await readJson("pending.json")).toMatchObject({ id, image: IMAGE });
    expect((await readdir(spool)).sort()).toEqual(["pending.json", "request.json"]);
  });

  it("reports idle on a node that was never asked to update", async () => {
    expect(await service().getStatus()).toMatchObject({
      state: "idle",
      image: null,
      log: "",
      updatedAt: null,
    });
  });

  it("reports requested while the trigger file is still there", async () => {
    const svc = service();
    await svc.requestUpdate(IMAGE);

    expect(await svc.getStatus()).toMatchObject({ state: "requested", image: IMAGE });
  });

  it("reports running once the updater has consumed the request", async () => {
    const svc = service();
    await svc.requestUpdate(IMAGE);
    await rm(join(spool, "request.json"));

    // This is the window in which the agent is killed and replaced, so the
    // state has to come from the spool and not from anything held in memory.
    expect(await svc.getStatus()).toMatchObject({ state: "running", image: IMAGE });
  });

  it("reports the outcome the updater wrote", async () => {
    const svc = service();
    const { id } = await svc.requestUpdate(IMAGE);
    await rm(join(spool, "request.json"));
    await writeFile(
      join(spool, "result.json"),
      JSON.stringify({ id, finishedAt: "2026-09-03T10:00:00Z", ok: true, image: IMAGE, message: "updated" }),
    );
    await writeFile(join(spool, "update.log"), "pulled\nrecreated\n");

    expect(await svc.getStatus()).toMatchObject({
      state: "succeeded",
      image: IMAGE,
      updatedAt: "2026-09-03T10:00:00Z",
      log: "pulled\nrecreated\n",
    });
  });

  it("reports a failure with the log the operator has to read", async () => {
    const svc = service();
    const { id } = await svc.requestUpdate(IMAGE);
    await rm(join(spool, "request.json"));
    await writeFile(
      join(spool, "result.json"),
      JSON.stringify({ id, finishedAt: "2026-09-03T10:00:00Z", ok: false, image: IMAGE, message: "health gate" }),
    );
    await writeFile(join(spool, "update.log"), "compose.yaml has local edits\n");

    const status = await svc.getStatus();
    expect(status.state).toBe("failed");
    expect(status.message).toContain("health gate");
    expect(status.log).toContain("local edits");
  });

  it("still reports a result left by an earlier update after a restart", async () => {
    // Nothing pending: the agent that made the request is gone, replaced by
    // the one answering now.
    await writeFile(
      join(spool, "result.json"),
      JSON.stringify({ id: "older", finishedAt: "2026-09-02T09:00:00Z", ok: true, image: IMAGE, message: "updated" }),
    );

    expect(await service().getStatus()).toMatchObject({
      state: "succeeded",
      updatedAt: "2026-09-02T09:00:00Z",
    });
  });

  it("truncates a log that would otherwise be unbounded", async () => {
    await writeFile(join(spool, "update.log"), "x".repeat(200_000));

    const status = await service().getStatus();
    expect(status.log.length).toBeLessThanOrEqual(64 * 1024);
    // Keep the end: a failure's reason is on the last lines, not the first.
    expect(status.log.endsWith("x")).toBe(true);
  });

  it("survives a spool whose files are unreadable or malformed", async () => {
    await writeFile(join(spool, "result.json"), "{ not json");

    // A node that cannot parse its own spool must still answer; the panel's
    // fallback is "unknown", never a 500 that looks like the node is down.
    expect(await service().getStatus()).toMatchObject({ state: "idle" });
  });

  // Creating a symlink needs a privilege the Windows dev box does not grant;
  // the node-agent CI job runs on Linux, where this is the real check.
  it.skipIf(process.platform === "win32")("never follows a symlink planted at the request path", async () => {
    const victim = join(spool, "victim.txt");
    await writeFile(victim, "keep me\n");
    await symlink(victim, join(spool, "request.json"));

    await service().requestUpdate(IMAGE);

    // The write is temp-file-then-rename, so it replaces the link instead of
    // writing through it - the same property the host-side updater relies on.
    expect(await readFile(victim, "utf8")).toBe("keep me\n");
    expect((await readJson("request.json")).image).toBe(IMAGE);
  });
});
