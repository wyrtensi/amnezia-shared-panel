import {
  AMNEZIA_WG_CONFIG_FIXTURE,
  AMNEZIA_WG3_CONFIG_FIXTURE,
  createAmneziaBackupFixture,
} from "../fixtures";
import { Protocol } from "@/types/shared";
import { PeerStatus } from "@/types/clients";
import { decodeVpnConfig } from "../helpers";
import { AppContract } from "@/contracts/app";
import appConfig from "@/constants/appConfig";
import type { ProtocolFixture } from "../types";
import { createAmneziaConnectionMock } from "../mocks";
import { AmneziaWgService } from "@/services/amneziaWg";
import { AmneziaWg2Service } from "@/services/amneziaWg2";
import { AmneziaWg3Service } from "@/services/amneziaWg3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const originalAppConfig = {
  SERVER_MAX_PEERS: appConfig.SERVER_MAX_PEERS,
  SERVER_NAME: appConfig.SERVER_NAME,
  SERVER_PUBLIC_HOST: appConfig.SERVER_PUBLIC_HOST,
};

/**
 * Создать фикстуры сервисов AmneziaWG
 */
const protocolFixtures: ProtocolFixture[] = [
  {
    name: "AmneziaWgService",
    protocolName: "AmneziaWG",
    protocol: Protocol.AMNEZIAWG,
    container: AppContract.AmneziaWG.DOCKER_CONTAINER,
    createService: (connection) => new AmneziaWgService(connection),
  },
  {
    name: "AmneziaWg2Service",
    protocolName: "AmneziaWG2",
    protocol: Protocol.AMNEZIAWG2,
    container: "amnezia-awg2",
    createService: (connection) => new AmneziaWg2Service(connection),
  },
  {
    name: "AmneziaWg3Service",
    protocolName: "AmneziaWG3",
    protocol: Protocol.AMNEZIAWG3,
    container: "amnezia-awg2",
    createService: (connection) => new AmneziaWg3Service(connection),
  },
];

/**
 * Настроить конфигурацию приложения для тестов протоколов
 */
beforeEach(() => {
  appConfig.SERVER_MAX_PEERS = 100;
  appConfig.SERVER_NAME = "{username} via {protocol}";
  appConfig.SERVER_PUBLIC_HOST = "vpn.example.com";
});

/**
 * Восстановить конфигурацию приложения
 */
afterEach(() => {
  Object.assign(appConfig, originalAppConfig);
});

/**
 * Тестирование сервисов AmneziaWG
 */
describe.each(protocolFixtures)("$name", (fixture) => {
  /**
   * Создать субъект тестирования
   */
  const createSubject = (connection = createAmneziaConnectionMock()) => ({
    service: fixture.createService(connection.connection),
    connection,
  });

  // Тестирование преобразования dump в записи клиентов
  it("maps active and disabled peers from the WireGuard dump", async () => {
    const { service } = createSubject();

    const clients = await service.getClients();

    expect(clients).toHaveLength(2);
    expect(clients[0]).toMatchObject({
      username: "alice",
      peers: [
        {
          id: "active-id",
          name: "macbook",
          status: PeerStatus.Active,
          traffic: { received: 100, sent: 200 },
          protocol: fixture.protocol,
        },
      ],
    });
    expect(clients[1]).toMatchObject({
      username: "bob",
      peers: [
        {
          id: "disabled-id",
          status: PeerStatus.Disabled,
          protocol: fixture.protocol,
        },
      ],
    });
  });

  // Тестирование создания клиента и конфигурации vpn://
  it("creates a client and returns an importable VPN config", async () => {
    const { service, connection } = createSubject();

    const result = await service.createClient("charlie", {
      expiresAt: 4_102_444_800,
    });

    expect(result).toMatchObject({
      id: "generated-client-id",
      protocol: fixture.protocol,
    });
    expect(result.config).toMatch(/^vpn:\/\//);
    expect(connection.state.wgConfig).toContain(
      "PublicKey = generated-client-id",
    );
    expect(connection.state.clientsTable.at(-1)).toMatchObject({
      clientId: "generated-client-id",
      userData: {
        clientName: "charlie",
        expiresAt: 4_102_444_800,
      },
    });
    expect(decodeVpnConfig(result.config)).toMatchObject({
      defaultContainer: fixture.container,
      description: `charlie via ${fixture.protocolName}`,
      hostName: "vpn.example.com",
    });
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });

  // Тестирование отключения и повторного включения клиента
  it("disables a client and restores its original allowed IP", async () => {
    const { service, connection } = createSubject();

    await expect(
      service.updateClient("active-id", { status: PeerStatus.Disabled }),
    ).resolves.toBe(true);
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 0\.0\.0\.0\/32/,
    );

    await expect(
      service.updateClient("active-id", { status: PeerStatus.Active }),
    ).resolves.toBe(true);
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 10\.8\.1\.2\/32/,
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledTimes(2);
  });

  // Тестирование удаления клиента из таблицы и конфигурации
  it("deletes a client without removing other peers", async () => {
    const { service, connection } = createSubject();

    await expect(service.deleteClient("active-id")).resolves.toBe(true);

    expect(connection.state.clientsTable).toHaveLength(1);
    expect(connection.state.clientsTable[0]?.clientId).toBe("disabled-id");
    expect(connection.state.wgConfig).not.toContain("PublicKey = active-id");
    expect(connection.state.wgConfig).toContain("PublicKey = disabled-id");
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();

    await expect(service.deleteClient("missing-id")).resolves.toBe(false);
  });

  // Тестирование отключения клиентов с истекшим сроком действия
  it("disables expired clients and preserves their original IP", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: AMNEZIA_WG_CONFIG_FIXTURE,
      clientsTable: [
        {
          clientId: "active-id",
          userData: {
            clientName: "expired",
            expiresAt: 1_700_000_000,
          },
        },
      ],
    });
    const { service } = createSubject(connection);

    await expect(service.disableExpiredClients()).resolves.toBe(1);

    expect(connection.state.clientsTable[0]?.userData?.allowedIp).toBe(
      "10.8.1.2",
    );
    expect(connection.state.wgConfig).toMatch(
      /PublicKey = active-id\nAllowedIPs = 0\.0\.0\.0\/32/,
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });

  // Тестирование экспорта и импорта резервной копии
  it("exports and imports all protocol backup files", async () => {
    const { service, connection } = createSubject();

    await expect(service.exportBackup()).resolves.toEqual(
      createAmneziaBackupFixture(),
    );

    const backup = {
      ...createAmneziaBackupFixture(),
      wgConfig: "[Interface]\nAddress = 10.9.0.1/24\n",
      serverPublicKey: " imported-public-key ",
      presharedKey: " imported-preshared-key ",
      clients: [],
    };

    await service.importBackup(backup);

    expect(connection.state.wgConfig).toBe(backup.wgConfig);
    expect(connection.state.clientsTable).toEqual([]);
    expect(Object.values(connection.state.files)).toContain(
      "imported-public-key\n",
    );
    expect(Object.values(connection.state.files)).toContain(
      "imported-preshared-key\n",
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });
});

describe("AmneziaWg2Service CIDR allocation", () => {
  it("creates a peer beyond the first /24 of a larger server subnet", async () => {
    appConfig.SERVER_MAX_PEERS = 500;
    const peers = Array.from({ length: 255 }, (_, index) => {
      const address = `10.89.0.${index + 1}`;
      return `[Peer]\nPublicKey = peer-${index + 1}\nAllowedIPs = ${address}/32`;
    }).join("\n\n");
    const connection = createAmneziaConnectionMock({
      wgConfig: `[Interface]\nAddress = 10.89.0.1/22\nListenPort = 51889\n\n${peers}\n`,
      wgDump: "",
      clientsTable: [],
    });
    const service = new AmneziaWg2Service(connection.connection);

    const result = await service.createClient("capacity-test");

    expect(connection.state.wgConfig).toContain("AllowedIPs = 10.89.1.0/32");
    const decoded = decodeVpnConfig(result.config) as {
      containers: Array<{ awg: { last_config: string } }>;
    };
    const awgContainer = decoded.containers[0];
    expect(JSON.parse(awgContainer.awg.last_config)).toMatchObject({
      client_ip: "10.89.1.0",
    });
  });

  it("serializes concurrent peer creation without losing allocations", async () => {
    appConfig.SERVER_MAX_PEERS = 500;
    const connection = createAmneziaConnectionMock({
      wgConfig: "[Interface]\nAddress = 10.89.0.1/22\nListenPort = 51889\n",
      wgDump: "",
      clientsTable: [],
    });
    let keySequence = 0;
    connection.spies.run.mockImplementation(async (command) => {
      if (command === "awg genkey") {
        keySequence += 1;
        return { stdout: `private-${keySequence}\n`, stderr: "" };
      }
      const privateKey = command.match(/echo 'private-(\d+)'/)?.[1];
      if (privateKey) {
        return { stdout: `public-${privateKey}\n`, stderr: "" };
      }
      return { stdout: "", stderr: "" };
    });
    const service = new AmneziaWg2Service(connection.connection);

    await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        service.createClient(`parallel-${index}`),
      ),
    );

    const allocatedAddresses = Array.from(
      connection.state.wgConfig.matchAll(/AllowedIPs = (10\.89\.\d+\.\d+)\/32/g),
      (match) => match[1],
    );
    expect(allocatedAddresses).toHaveLength(10);
    expect(new Set(allocatedAddresses).size).toBe(10);
    expect(connection.state.clientsTable).toHaveLength(10);
  });
});

describe("AmneziaWg2Service mutation recovery", () => {
  it("persists the deterministic label before exposing a new peer", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: "[Interface]\nAddress = 10.89.0.1/22\nListenPort = 51889\n",
      wgDump: "",
      clientsTable: [],
    });
    const service = new AmneziaWg2Service(connection.connection);

    await service.createClient("deterministic-label");

    expect(
      connection.spies.writeClientsTable.mock.invocationCallOrder[0],
    ).toBeLessThan(connection.spies.writeWgConfig.mock.invocationCallOrder[0]);
  });

  it("keeps metadata when applying a newly written peer is ambiguous", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: "[Interface]\nAddress = 10.89.0.1/22\nListenPort = 51889\n",
      wgDump: "",
      clientsTable: [],
    });
    connection.spies.syncWgConfig.mockRejectedValueOnce(
      new Error("sync result unknown"),
    );
    const service = new AmneziaWg2Service(connection.connection);

    await expect(service.createClient("deterministic-label")).rejects.toThrow(
      "sync result unknown",
    );

    expect(connection.state.clientsTable).toEqual([
      expect.objectContaining({
        clientId: "generated-client-id",
        userData: expect.objectContaining({
          clientName: "deterministic-label",
        }),
      }),
    ]);
  });

  it("removes a config-only orphan idempotently", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig:
        "[Interface]\nAddress = 10.89.0.1/22\n\n[Peer]\nPublicKey = orphan-id\nAllowedIPs = 10.89.0.2/32\n",
      wgDump: "",
      clientsTable: [],
    });
    const service = new AmneziaWg2Service(connection.connection);

    await expect(service.deleteClient("orphan-id")).resolves.toBe(true);

    expect(connection.state.wgConfig).not.toContain("orphan-id");
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });

  it("retains metadata until peer removal has been applied", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig:
        "[Interface]\nAddress = 10.89.0.1/22\n\n[Peer]\nPublicKey = active-id\nAllowedIPs = 10.89.0.2/32\n",
      wgDump: "",
      clientsTable: [
        {
          clientId: "active-id",
          userData: { clientName: "deterministic-label" },
        },
      ],
    });
    connection.spies.syncWgConfig.mockRejectedValueOnce(
      new Error("sync result unknown"),
    );
    const service = new AmneziaWg2Service(connection.connection);

    await expect(service.deleteClient("active-id")).rejects.toThrow(
      "sync result unknown",
    );

    expect(connection.state.clientsTable).toHaveLength(1);
  });
});

describe("AmneziaWg2Service config-driven client inventory", () => {
  it("reports a configured disabled peer that is absent from the live dump", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: `[Interface]\nAddress = 10.89.0.1/22\n\n[Peer]\nPublicKey = disabled-config-id\nAllowedIPs = 0.0.0.0/32\n`,
      wgDump: "",
      clientsTable: [
        {
          clientId: "disabled-config-id",
          userData: {
            clientName: "employee [phone]",
            allowedIp: "10.89.0.2",
          },
        },
      ],
    });
    const service = new AmneziaWg2Service(connection.connection);

    const clients = await service.getClients();

    expect(clients).toEqual([
      {
        username: "employee",
        peers: [
          expect.objectContaining({
            id: "disabled-config-id",
            name: "phone",
            status: PeerStatus.Disabled,
            allowedIps: ["0.0.0.0/32"],
            online: false,
            endpoint: null,
            lastHandshake: 0,
            traffic: { received: 0, sent: 0 },
          }),
        ],
      },
    ]);
  });

  it("excludes dump-only peers that are not present in the persisted config", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: `[Interface]\nAddress = 10.89.0.1/22\n\n[Peer]\nPublicKey = managed-id\nAllowedIPs = 10.89.0.2/32\n`,
      wgDump:
        "stray-id\tpsk\t198.51.100.2:51889\t10.89.0.9/32\t10\t20\t30\t25",
      clientsTable: [
        {
          clientId: "managed-id",
          userData: { clientName: "employee", allowedIp: "10.89.0.2" },
        },
      ],
    });
    const service = new AmneziaWg2Service(connection.connection);

    const clients = await service.getClients();

    expect(clients).toHaveLength(1);
    expect(clients[0]?.peers).toHaveLength(1);
    expect(clients[0]?.peers[0]?.id).toBe("managed-id");
  });
});

type DecodedVpnConfig = {
  containers: Array<{
    awg: { protocol_version?: string; last_config: string } & Record<
      string,
      unknown
    >;
  }>;
};

describe("AmneziaWg3Service AmneziaWG 3.1 parameters", () => {
  beforeEach(() => {
    appConfig.SERVER_MAX_PEERS = 100;
    appConfig.SERVER_NAME = "{username} via {protocol}";
    appConfig.SERVER_PUBLIC_HOST = "vpn.example.com";
  });

  it("emits a 3.1 client config when the server config carries 3.1 parameters", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: AMNEZIA_WG3_CONFIG_FIXTURE,
      wgDump: "",
      clientsTable: [],
    });
    const service = new AmneziaWg3Service(connection.connection);

    const result = await service.createClient("charlie");

    expect(result.protocol).toBe(Protocol.AMNEZIAWG3);
    const decoded = decodeVpnConfig(result.config) as DecodedVpnConfig;
    const awgContainer = decoded.containers[0].awg;
    expect(awgContainer.protocol_version).toBe("3.1");

    const lastConfig = JSON.parse(awgContainer.last_config) as {
      config: string;
    };
    // 3.1 parameters are carried into the client [Interface]
    expect(lastConfig.config).toContain("HeaderProtectionKey = ");
    expect(lastConfig.config).toContain("RandomTrailers = on");
    expect(lastConfig.config).toContain("DisableCookies = on");
    expect(lastConfig.config).toContain("RekeyAfterTime = 120");
    expect(lastConfig.config).toContain("H1 = 1000-2000");
    // In 3.1 PersistentKeepalive is a range
    expect(lastConfig.config).toContain("PersistentKeepalive = 25-35");
    // Unset 3.1 parameters are dropped from the client config
    expect(lastConfig.config).not.toContain("RekeyTimeout = \n");
    expect(lastConfig.config).not.toMatch(/MaxHandshakeAttempts\s*=\s*$/m);
  });

  it("falls back to a 2.0 client config when the server is still on 2.0", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: AMNEZIA_WG_CONFIG_FIXTURE,
      wgDump: "",
      clientsTable: [],
    });
    const service = new AmneziaWg3Service(connection.connection);

    const result = await service.createClient("charlie");

    const decoded = decodeVpnConfig(result.config) as DecodedVpnConfig;
    const awgContainer = decoded.containers[0].awg;
    expect(awgContainer.protocol_version).toBe("2");

    const lastConfig = JSON.parse(awgContainer.last_config) as {
      config: string;
    };
    // No 3.1 parameters are emitted for a 2.0 server
    expect(lastConfig.config).not.toContain("HeaderProtectionKey");
    expect(lastConfig.config).not.toContain("RandomTrailers");
    expect(lastConfig.config).toContain("PersistentKeepalive = 25");
  });

  it("shells mutations out to the amnezia-awg3 container", async () => {
    const connection = createAmneziaConnectionMock({
      wgConfig: AMNEZIA_WG3_CONFIG_FIXTURE,
      wgDump: "",
      clientsTable: [],
    });
    const service = new AmneziaWg3Service(connection.connection);

    await service.createClient("charlie");

    expect(connection.state.wgConfig).toContain(
      "PublicKey = generated-client-id",
    );
    expect(connection.spies.syncWgConfig).toHaveBeenCalledOnce();
  });
});
