import { describe, expect, it } from "vitest";

import {
  messageBeyondImage,
  shortDigest,
  splitImageRef,
} from "@/lib/agent-update";

const IMAGE =
  "ghcr.io/wyrtensi/amnezia-shared-panel/node-agent@sha256:b5b9cc99cf71a0f24c17f9d2e8b3a6c5d40e71f8a92c3b4d5e6f70819a2b3c4d";

describe("splitImageRef", () => {
  it("splits a digest reference so only the repository may be truncated", () => {
    expect(splitImageRef(IMAGE)).toEqual({
      repo: "ghcr.io/wyrtensi/amnezia-shared-panel/node-agent",
      digest:
        "sha256:b5b9cc99cf71a0f24c17f9d2e8b3a6c5d40e71f8a92c3b4d5e6f70819a2b3c4d",
    });
  });

  it("keeps a reference with no digest whole rather than guessing", () => {
    expect(splitImageRef("ghcr.io/owner/node-agent:v1.2.3")).toEqual({
      repo: "ghcr.io/owner/node-agent:v1.2.3",
      digest: null,
    });
  });
});

describe("shortDigest", () => {
  it("keeps the algorithm and twelve hex characters", () => {
    expect(
      shortDigest(
        "sha256:b5b9cc99cf71a0f24c17f9d2e8b3a6c5d40e71f8a92c3b4d5e6f70819a2b3c4d",
      ),
    ).toBe("sha256:b5b9cc99cf71");
  });

  it("falls back to a plain prefix for an unrecognised digest", () => {
    expect(shortDigest("deadbeefdeadbeefdeadbeef")).toBe("deadbeefdeadbeefdea");
  });
});

describe("messageBeyondImage", () => {
  it("drops the repeated reference and keeps the words around it", () => {
    // The bug this exists for: the card printed the image, then printed the
    // node's `already running <same image>` under it, and the second copy
    // wrapped over four lines.
    const summary = messageBeyondImage(`already running ${IMAGE}`, IMAGE);
    expect(summary).toBe("already running …");
    expect(summary).not.toContain("b5b9cc99cf71");
  });

  it("keeps a failure readable while still eliding the digest", () => {
    expect(
      messageBeyondImage(`pull failed: manifest unknown for ${IMAGE}`, IMAGE),
    ).toBe("pull failed: manifest unknown for …");
  });

  it("returns nothing when the message was only the reference", () => {
    expect(messageBeyondImage(IMAGE, IMAGE)).toBe("");
    expect(messageBeyondImage(`  ${IMAGE}  `, IMAGE)).toBe("");
  });

  it("elides a digest the node quoted without the repository", () => {
    // The panel only knows the image it asked for; a node is free to answer
    // about a different one, and that digest is just as unbreakable.
    expect(
      messageBeyondImage(
        "rolled back to sha256:77aa31de90bb4c5f6e2d1a8c9b0f3e7d6a5c4b3a29187f6e5d4c3b2a19087f6e",
        IMAGE,
      ),
    ).toBe("rolled back to …");
  });

  it("leaves a message that says something of its own alone", () => {
    expect(messageBeyondImage("health check timed out after 60s", IMAGE)).toBe(
      "health check timed out after 60s",
    );
  });

  it("handles an absent message and an absent image", () => {
    expect(messageBeyondImage(null, IMAGE)).toBe("");
    expect(messageBeyondImage("   ", IMAGE)).toBe("");
    expect(messageBeyondImage("recreating the agent", null)).toBe(
      "recreating the agent",
    );
  });
});
