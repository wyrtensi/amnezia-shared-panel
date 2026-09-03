import { beforeEach, describe, expect, it, vi } from "vitest";

// vi.mock is hoisted above the imports, so the fake must be hoisted too.
const execMock = vi.hoisted(() => vi.fn());
vi.mock("child_process", () => ({ exec: execMock }));

import { AppContract } from "@/contracts/app";
import { APIError } from "@/utils/APIError";
import { ServerConnection } from "@/helpers/serverConnection";
import { XrayConnection } from "@/helpers/xrayConnection";
import { AmneziaWgConnection } from "@/helpers/amneziaWgConnection";
import { AmneziaWg2Connection } from "@/helpers/amneziaWg2Connection";
import { AmneziaWg3Connection } from "@/helpers/amneziaWg3Connection";

const PRIVATE_KEY = "qJ5s0vQ8kK3mX7nZ1pB2rT4wY6uI8oA0sD2fG4hJ6lM=";
const WG_CONFIG = [
  "[Interface]",
  "Address = 10.8.1.1/24",
  `PrivateKey = ${PRIVATE_KEY}`,
  "",
  "[Peer]",
  "AllowedIPs = 10.8.1.2/32",
].join("\n");
const ENCODED = Buffer.from(WG_CONFIG, "utf-8").toString("base64");

/**
 * Fail every exec() the way child_process really does: the ExecException
 * message repeats the whole command. The wording must not match
 * utils/dockerErrors.ts, or run() takes the APIError branch instead.
 */
const failExec = () => {
  execMock.mockImplementation((cmd: string, _options: unknown, cb: unknown) => {
    const callback = cb as (e: Error, out: string, err: string) => void;
    callback(new Error(`Command failed: ${cmd}\nwg-quick: parse error`), "", "");
    return undefined;
  });
};

beforeEach(failExec);

const wgFixtures = [
  { name: "AmneziaWgConnection", create: () => new AmneziaWgConnection() },
  { name: "AmneziaWg2Connection", create: () => new AmneziaWg2Connection() },
  { name: "AmneziaWg3Connection", create: () => new AmneziaWg3Connection() },
];

describe.each(wgFixtures)("$name.writeWgConfig failure", (fixture) => {
  it("never puts the encoded config or the private key in the rejection", async () => {
    const connection = fixture.create();

    await expect(connection.writeWgConfig(WG_CONFIG)).rejects.toThrow();
    const message = await connection
      .writeWgConfig(WG_CONFIG)
      .then(() => "", (e: Error) => e.message);

    expect(execMock).toHaveBeenCalled();
    expect(message).not.toContain(ENCODED);
    expect(message).not.toContain(PRIVATE_KEY);
    // Still diagnosable.
    expect(message).toContain("wg-quick: parse error");
  });
});

describe("XrayConnection", () => {
  it("redacts in run()", async () => {
    const connection = new XrayConnection();
    const message = await connection
      .writeFile("/opt/amnezia/xray/config.json", WG_CONFIG)
      .then(() => "", (e: Error) => e.message);

    expect(message).not.toContain(ENCODED);
  });

  it("redacts in runOnHost() — the second site in the same file", async () => {
    const connection = new XrayConnection();
    const cmd = `echo '${ENCODED}' | base64 -d > /tmp/x`;
    const message = await connection
      .runOnHost(cmd)
      .then(() => "", (e: Error) => e.message);

    expect(message).not.toContain(ENCODED);
  });
});

describe("ServerConnection", () => {
  it("redacts in run() — a site the audit did not name", async () => {
    const connection = new ServerConnection();
    const cmd = `echo '${ENCODED}' | base64 -d > /tmp/x`;
    const message = await connection
      .run(cmd)
      .then(() => "", (e: Error) => e.message);

    expect(message).not.toContain(ENCODED);
  });
});

describe("the docker-unavailable branches still win", () => {
  it("maps a daemon error to an APIError, not to a redacted Error", async () => {
    execMock.mockImplementation((_cmd: string, _o: unknown, cb: unknown) => {
      const callback = cb as (e: Error, out: string, err: string) => void;
      callback(new Error("Cannot connect to the Docker daemon"), "", "");
      return undefined;
    });
    const connection = new AmneziaWgConnection();

    const error = await connection
      .run(`echo '${ENCODED}' | base64 -d`)
      .then(() => null, (e: Error) => e);

    // The docker branch must win over the redacted-Error branch. Asserted by
    // type and status rather than by `.message`, because APIError declares
    // `public message!: I18n` and the ES2022 class-field semantics of this
    // tsconfig re-define that property to undefined after super() sets it --
    // a live defect in APIError, unrelated to redaction and out of T1's scope.
    // See plans/2026-09-02-T1-security-fixes.md "Execution notes".
    expect(error).toBeInstanceOf(APIError);
    expect((error as APIError).statusCode).toBe(503);
    // Whatever the branch, the payload must not ride along.
    expect(String(error)).not.toContain(ENCODED);
    expect(String(error)).not.toContain(PRIVATE_KEY);
    expect(AppContract.AmneziaWG.DOCKER_CONTAINER).toBe("amnezia-awg");
  });
});
