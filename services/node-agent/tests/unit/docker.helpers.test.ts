import {
  isDockerDaemonUnavailableError,
  isDockerContainerUnavailableError,
} from "@/utils/dockerErrors";
import {
  parseBytes,
  parseNetIo,
  parseMemUsage,
  parseCpuPercent,
} from "@/helpers/dockerStats";
import { describe, expect, it } from "vitest";
import {
  buildValidatedWgConfigCommand,
  buildWriteFileCommand,
  encodeWritePayload,
} from "@/utils/shellWrite";

/**
 * Тестирование распознавания ошибок Docker
 */
describe("dockerErrors", () => {
  // Тестирование распознавания недоступного Docker daemon
  it.each([
    "Cannot connect to the Docker daemon at unix:///var/run/docker.sock",
    "/bin/sh: 1: docker: not found",
    "command not found: docker",
  ])("recognizes an unavailable Docker daemon: %s", (message) => {
    expect(isDockerDaemonUnavailableError(new Error(message))).toBe(true);
    expect(isDockerContainerUnavailableError(new Error(message))).toBe(false);
  });

  // Тестирование распознавания отсутствующего контейнера
  it.each([
    "Error: No such container: amnezia-awg",
    "Container amnezia-xray is not running",
    "docker: Error response from daemon",
  ])("recognizes an unavailable container: %s", (message) => {
    expect(isDockerContainerUnavailableError(new Error(message))).toBe(true);
  });

  // Тестирование отклонения неизвестной ошибки
  it("does not classify an unrelated command error", () => {
    const error = new Error("permission denied");

    expect(isDockerDaemonUnavailableError(error)).toBe(false);
    expect(isDockerContainerUnavailableError(error)).toBe(false);
  });
});

/**
 * Тестирование парсеров статистики Docker
 */
describe("dockerStats", () => {
  // Тестирование преобразования десятичных и двоичных единиц
  it("converts Docker byte units", () => {
    expect(parseBytes("1.5kB")).toBe(1_500);
    expect(parseBytes("1.5MiB")).toBe(1_572_864);
    expect(parseBytes("invalid")).toBeNull();
  });

  // Тестирование преобразования CPU, памяти и сети
  it("parses CPU, memory and network stats", () => {
    expect(parseCpuPercent("12.34%")).toBe(12.34);
    expect(parseMemUsage("12MiB / 2GiB")).toEqual({
      usage: 12_582_912,
      limit: 2_147_483_648,
    });
    expect(parseNetIo("1.2kB / 3.4kB")).toEqual({
      rx: 1_200,
      tx: 3_400,
    });
  });
});

/**
 * Тестирование безопасной записи файлов
 */
describe("buildWriteFileCommand", () => {
  // Тестирование кодирования содержимого и атомарного перемещения
  it("builds an atomic command that carries no content at all", () => {
    const command = buildWriteFileCommand("/tmp/config.json");

    expect(command).toContain("base64 -d > '/tmp/config.json.tmp'");
    expect(command).toContain(
      "mv -f '/tmp/config.json.tmp' '/tmp/config.json'",
    );
  });

  // The regression this whole shape exists for. The content used to be
  // interpolated into the command as base64, and `exec` passes a command as ONE
  // argv string, which Linux caps at MAX_ARG_STRLEN (128 KiB). The clients
  // table crossed that at roughly 420 peers, and from there every create failed
  // with E2BIG while both peer caps still reported free slots. Assert on the
  // property that prevents it: command length must not depend on content size.
  it("keeps the command a fixed size no matter how large the payload is", () => {
    const MAX_ARG_STRLEN = 128 * 1024;
    const small = encodeWritePayload("x");
    const huge = encodeWritePayload("y".repeat(4 * MAX_ARG_STRLEN));

    const command = buildWriteFileCommand("/opt/amnezia/awg/clientsTable");

    expect(huge.length).toBeGreaterThan(MAX_ARG_STRLEN);
    expect(command.length).toBeLessThan(1024);
    expect(command).not.toContain(small);
    expect(command).not.toContain(huge);
  });

  // The temp file is created by `>`, so it gets the shell's umask (0644 here),
  // and `mv -f` replaces the target together with its mode. Every write
  // therefore widened a state file the entrypoint had created 0600, and
  // preflight refused the next deploy on that node.
  it("sets the mode on the temp file before it replaces the target", () => {
    const command = buildWriteFileCommand("/tmp/config.json");

    expect(command).toContain("chmod 600 '/tmp/config.json.tmp'");
    expect(command.indexOf("chmod 600")).toBeLessThan(command.indexOf("mv -f"));
  });

  it("validates and durably replaces a WireGuard config", () => {
    const command = buildValidatedWgConfigCommand(
      "/opt/amnezia/awg/awg0.conf",
      "awg-quick",
    );

    expect(command).toContain("'/opt/amnezia/awg/.awg0.tmp.conf'");
    expect(command).toContain(
      "awg-quick strip '/opt/amnezia/awg/.awg0.tmp.conf' > /dev/null",
    );
    expect(command).toContain("sync &&");
    expect(command).toContain(
      "mv -f '/opt/amnezia/awg/.awg0.tmp.conf' '/opt/amnezia/awg/awg0.conf'",
    );
    expect(command).toContain(
      "rm -f '/opt/amnezia/awg/.awg0.tmp.conf'",
    );
  });
});
