import {
  createXrayConnectionMock,
  createAmneziaConnectionMock,
} from "../mocks";
import {
  createAmneziaBackupFixture,
  createXrayServerConfigFixture,
} from "../fixtures";
import { Protocol } from "@/types/shared";
import appConfig from "@/constants/appConfig";
import { XrayService } from "@/services/xray";
import { ServerService } from "@/services/server";
import { ClientsService } from "@/services/clients";
import { ServerBackupPayload } from "@/types/server";
import { AmneziaWgService } from "@/services/amneziaWg";
import { AmneziaWg2Service } from "@/services/amneziaWg2";
import { AmneziaWg3Service } from "@/services/amneziaWg3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The two host files the metrics call reads. They do not exist on the Windows
// dev box and differ between kernels in CI, so they are supplied here and every
// other path still goes to the real fs - the point of the test is the wiring,
// and the parsers have their own table-driven tests.
const MEMINFO = [
  "MemTotal:         984064 kB",
  "MemFree:           98304 kB",
  "MemAvailable:     344800 kB",
  "SwapTotal:       1048572 kB",
  "SwapFree:         555000 kB",
  "",
].join("\n");

vi.mock("fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs/promises")>();
  const readFile = (path: unknown, encoding?: unknown) => {
    if (path === "/proc/meminfo") return Promise.resolve(MEMINFO);
    if (path === "/sys/fs/cgroup/pids.current") return Promise.resolve("12\n");
    if (path === "/sys/fs/cgroup/pids.max") return Promise.resolve("128\n");
    return (actual.readFile as (...args: unknown[]) => Promise<unknown>)(
      path,
      encoding,
    );
  };
  return { ...actual, default: { ...actual, readFile }, readFile };
});

const originalAppConfig = {
  SERVER_ID: appConfig.SERVER_ID,
  SERVER_REGION: appConfig.SERVER_REGION,
  SERVER_WEIGHT: appConfig.SERVER_WEIGHT,
  SERVER_MAX_PEERS: appConfig.SERVER_MAX_PEERS,
  PROTOCOLS_ENABLED: appConfig.PROTOCOLS_ENABLED,
};

/**
 * Создать субъект тестирования
 */
const createSubject = () => {
  const amneziaWgConnection = createAmneziaConnectionMock();
  const amneziaWg2Connection = createAmneziaConnectionMock();
  const amneziaWg3Connection = createAmneziaConnectionMock();
  const xrayConnection = createXrayConnectionMock(
    createXrayServerConfigFixture(),
  );

  const amneziaWgService = new AmneziaWgService(amneziaWgConnection.connection);
  const amneziaWg2Service = new AmneziaWg2Service(
    amneziaWg2Connection.connection,
  );
  const amneziaWg3Service = new AmneziaWg3Service(
    amneziaWg3Connection.connection,
  );
  const xrayService = new XrayService(xrayConnection.connection);
  const clientsService = new ClientsService(
    xrayService,
    amneziaWgService,
    amneziaWg2Service,
    amneziaWg3Service,
  );

  return {
    service: new ServerService(
      xrayService,
      clientsService,
      amneziaWgService,
      amneziaWg2Service,
      amneziaWg3Service,
    ),
    connections: {
      amneziaWg: amneziaWgConnection,
      amneziaWg2: amneziaWg2Connection,
      amneziaWg3: amneziaWg3Connection,
      xray: xrayConnection,
    },
  };
};

/**
 * Настроить метаданные тестового сервера
 */
beforeEach(() => {
  appConfig.SERVER_ID = "test-server-id";
  appConfig.SERVER_REGION = "test-region";
  appConfig.SERVER_WEIGHT = 150;
  appConfig.SERVER_MAX_PEERS = 200;
  appConfig.PROTOCOLS_ENABLED = [
    Protocol.AMNEZIAWG,
    Protocol.AMNEZIAWG2,
    Protocol.XRAY,
  ];
});

/**
 * Восстановить конфигурацию приложения
 */
afterEach(() => {
  Object.assign(appConfig, originalAppConfig);
});

/**
 * Тестирование сервиса управления сервером
 */
describe("ServerService", () => {
  // Тестирование агрегированной информации о сервере
  it("returns server metadata and total peer count", async () => {
    const { service } = createSubject();

    await expect(service.getServerStatus()).resolves.toEqual({
      id: "test-server-id",
      region: "test-region",
      weight: 150,
      maxPeers: 200,
      totalPeers: 6,
      protocols: [Protocol.AMNEZIAWG, Protocol.AMNEZIAWG2, Protocol.XRAY],
      publicHost: "127.0.0.1",
      // Read from the live interface config, not assumed from the protocol:
      // a node whose port was changed on the host stops being a mystery.
      listenPorts: [51820],
    });
  });

  // The metrics the panel's node card is built from. Every one of them is
  // nullable on the wire, so the assertions are about the shape being present
  // and the AWG entries following the protocols this node actually serves.
  it("reports host metrics and the state of the AWG interfaces it serves", async () => {
    const { service } = createSubject();

    const load = await service.getServerLoad();

    // MemAvailable, not MemFree: the two differ by the page cache on any real
    // host, and the node's own deploy gate reads MemAvailable - if the panel
    // read the other one the two would disagree about whether a node is healthy.
    expect(load.memory.availableBytes).toBe(344800 * 1024);
    expect(load.memory.totalBytes).toEqual(expect.any(Number));
    expect(load.swap).toEqual({
      totalBytes: 1048572 * 1024,
      usedBytes: (1048572 - 555000) * 1024,
    });
    expect(load.agent).toEqual({ pidsCurrent: 12, pidsMax: 128 });

    // The fixture enables amneziawg2 but not amneziawg3, and the payload must
    // say so rather than reporting a down interface for a protocol this node
    // was never asked to run.
    expect(load.awg.amneziawg2).toEqual({ up: true, peers: expect.any(Number) });
    expect(load.awg.amneziawg3).toBeNull();
  });

  // Тестирование экспорта резервной копии всех протоколов
  it("exports a complete multi-protocol backup", async () => {
    const { service } = createSubject();

    const backup = await service.exportBackup();

    expect(backup.generatedAt).toEqual(expect.any(String));
    expect(backup.serverId).toBe("test-server-id");
    expect(backup.protocols).toEqual([
      Protocol.AMNEZIAWG,
      Protocol.AMNEZIAWG2,
      Protocol.XRAY,
    ]);
    expect(backup.amnezia).toEqual(createAmneziaBackupFixture());
    expect(backup.amneziaWg2).toEqual(createAmneziaBackupFixture());
    expect(backup.xray).toMatchObject({
      uuid: "server-uuid",
      publicKey: "xray-public-key",
      privateKey: "xray-private-key",
      shortId: "short-id",
    });
  });

  // Тестирование импорта резервной копии всех протоколов
  it("imports a complete multi-protocol backup", async () => {
    const { service, connections } = createSubject();
    const xrayConfig = JSON.stringify(
      createXrayServerConfigFixture({ clients: [], clientsDisabled: [] }),
    );
    const backup: ServerBackupPayload = {
      generatedAt: "2026-08-04T00:00:00.000Z",
      serverId: "backup-server-id",
      protocols: [Protocol.AMNEZIAWG, Protocol.AMNEZIAWG2, Protocol.XRAY],
      amnezia: createAmneziaBackupFixture(),
      amneziaWg2: createAmneziaBackupFixture(),
      xray: {
        serverConfig: xrayConfig,
        uuid: "backup-uuid",
        publicKey: "backup-public-key",
        privateKey: "backup-private-key",
        shortId: "backup-short-id",
      },
    };

    await service.importBackup(backup);

    expect(connections.amneziaWg.spies.writeWgConfig).toHaveBeenCalledOnce();
    expect(connections.amneziaWg2.spies.writeWgConfig).toHaveBeenCalledOnce();
    expect(connections.xray.state.serverConfig).toBe(xrayConfig);
    expect(connections.amneziaWg.spies.syncWgConfig).toHaveBeenCalledOnce();
    expect(connections.amneziaWg2.spies.syncWgConfig).toHaveBeenCalledOnce();
    expect(connections.xray.spies.restartContainer).toHaveBeenCalledOnce();
  });

  // Тестирование отклонения неполной резервной копии
  it("rejects a backup without data for an enabled protocol", async () => {
    const { service, connections } = createSubject();
    const backup: ServerBackupPayload = {
      generatedAt: "2026-08-04T00:00:00.000Z",
      serverId: null,
      protocols: [Protocol.XRAY],
    };

    await expect(service.importBackup(backup)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(connections.xray.spies.writeServerConfig).not.toHaveBeenCalled();
    expect(connections.xray.spies.restartContainer).not.toHaveBeenCalled();
  });
});
