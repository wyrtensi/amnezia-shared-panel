import { describe, expect, it } from "vitest";
import { REDACTED, redactCommand } from "@/utils/redactCommand";
import {
  buildValidatedWgConfigCommand,
  buildWriteFileCommand,
} from "@/utils/shellWrite";

// A realistic awg0.conf. The values are syntactically valid but invented —
// never paste a real key into a test (AGENTS.md).
const PRIVATE_KEY = "qJ5s0vQ8kK3mX7nZ1pB2rT4wY6uI8oA0sD2fG4hJ6lM=";
const PRESHARED_KEY = "zY9xW8vU7tS6rQ5pO4nM3lK2jI1hG0fE9dC8bA7zY6x=";
const WG_CONFIG = [
  "[Interface]",
  "Address = 10.8.1.1/24",
  "ListenPort = 51820",
  `PrivateKey = ${PRIVATE_KEY}`,
  "",
  "[Peer]",
  "PublicKey = aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4c=",
  `PresharedKey = ${PRESHARED_KEY}`,
  "AllowedIPs = 10.8.1.2/32",
].join("\n");

// Mirror helpers/*Connection.ts buildCommand(): the error message carries this
// re-quoted form, not the raw command.
const dockerWrap = (cmd: string) =>
  `docker exec amnezia-awg sh -lc '${cmd.replace(/'/g, "'\\''")}'`;

describe("redactCommand", () => {
  it("removes the encoded config from a writeWgConfig command", () => {
    const cmd = buildValidatedWgConfigCommand(
      "/opt/amnezia/awg/wg0.conf",
      WG_CONFIG,
      "awg-quick",
    );
    const encoded = Buffer.from(WG_CONFIG, "utf-8").toString("base64");

    expect(cmd).toContain(encoded); // guard: the payload really is in there
    const redacted = redactCommand(cmd);

    expect(redacted).not.toContain(encoded);
    expect(redacted).toContain(REDACTED);
    // The diagnostically useful shape survives.
    expect(redacted).toContain("awg-quick strip");
    expect(redacted).toContain("/opt/amnezia/awg/wg0.conf");
  });

  it("removes it from the docker exec / sh -lc escaped form as well", () => {
    const cmd = buildWriteFileCommand("/opt/amnezia/awg/clientsTable", WG_CONFIG);
    const encoded = Buffer.from(WG_CONFIG, "utf-8").toString("base64");

    const redacted = redactCommand(dockerWrap(cmd));

    expect(redacted).not.toContain(encoded);
    expect(redacted).toContain("docker exec amnezia-awg");
  });

  it("removes it from a stringified exec error, which repeats the command", () => {
    const cmd = buildValidatedWgConfigCommand(
      "/opt/amnezia/awg/wg0.conf",
      WG_CONFIG,
      "awg-quick",
    );
    const encoded = Buffer.from(WG_CONFIG, "utf-8").toString("base64");
    const execError = `Error: Command failed: ${dockerWrap(cmd)}\nwg-quick: parse error`;

    const redacted = redactCommand(execError);

    expect(redacted).not.toContain(encoded);
    expect(redacted).toContain("wg-quick: parse error");
  });

  it("removes a key written out literally, e.g. echoed back in stderr", () => {
    const stderr = `Line unrecognized: 'PrivateKey = ${PRIVATE_KEY}'`;

    const redacted = redactCommand(stderr);

    expect(redacted).not.toContain(PRIVATE_KEY);
    expect(redacted).toBe(`Line unrecognized: 'PrivateKey = ${REDACTED}'`);
  });

  it("redacts PresharedKey and SecretKey the same way", () => {
    expect(redactCommand(`PresharedKey = ${PRESHARED_KEY}`)).not.toContain(
      PRESHARED_KEY,
    );
    expect(redactCommand(`SecretKey=${PRESHARED_KEY}`)).toBe(
      `SecretKey=${REDACTED}`,
    );
  });

  it("leaves ordinary commands and paths untouched", () => {
    for (const cmd of [
      "wg show wg0 dump",
      "cat /opt/amnezia/awg/wireguard_server_public_key.key 2>/dev/null || true",
      "docker exec amnezia-awg3 sh -lc 'awg genkey'",
      "systemctl restart amnezia-node-agent",
    ]) {
      expect(redactCommand(cmd)).toBe(cmd);
    }
  });

  it("keeps a public key, which is not secret and is useful in a log", () => {
    const line = "PublicKey = aB1cD2eF3gH4iJ5kL6mN7oP8qR9sT0uV1wX2yZ3aB4c=";
    expect(redactCommand(line)).toBe(line);
  });
});
