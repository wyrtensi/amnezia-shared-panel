import { Protocol } from "@/types/shared";
import { PeerStatus } from "@/types/clients";
import appConfig from "@/constants/appConfig";
import { createClientPeer, createClientRecord } from "../factories";
import { ClientsService } from "@/services/clients";
import { createProtocolServiceMock } from "../mocks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { encodeVpnConfig } from "@/helpers/encodeVpnConfig";
import { EgressService } from "@/services/egress";
import { TEST_SERVER_MAX_PEERS } from "../config/setupTestEnvironment";

const originalAppConfig = {
  SERVER_MAX_PEERS: appConfig.SERVER_MAX_PEERS,
  PROTOCOLS_ENABLED: appConfig.PROTOCOLS_ENABLED,
};

/**
 * Создать субъект тестирования
 */
const createSubject = () => {
  const xray = createProtocolServiceMock(Protocol.XRAY);
  const amneziaWg = createProtocolServiceMock(Protocol.AMNEZIAWG);
  const amneziaWg2 = createProtocolServiceMock(Protocol.AMNEZIAWG2);
  const amneziaWg3 = createProtocolServiceMock(Protocol.AMNEZIAWG3);

  return {
    service: new ClientsService(
      xray.service,
      amneziaWg.service,
      amneziaWg2.service,
      amneziaWg3.service,
    ),
    protocols: { xray, amneziaWg, amneziaWg2, amneziaWg3 },
  };
};

/**
 * Настроить конфигурацию приложения для тестов клиентов
 */
beforeEach(() => {
  appConfig.SERVER_MAX_PEERS = undefined;
  appConfig.PROTOCOLS_ENABLED = [
    Protocol.XRAY,
    Protocol.AMNEZIAWG,
    Protocol.AMNEZIAWG2,
    Protocol.AMNEZIAWG3,
  ];
});

/**
 * Восстановить конфигурацию приложения
 */
afterEach(() => {
  Object.assign(appConfig, originalAppConfig);
});

/**
 * Тестирование сервиса клиентов
 */
describe("ClientsService", () => {
  // Тестирование объединения пиров одного клиента из разных протоколов
  it("merges peers with the same username across enabled protocols", async () => {
    const xray = createProtocolServiceMock(Protocol.XRAY, [
      createClientRecord({ username: "alice", protocol: Protocol.XRAY }),
    ]);
    const amneziaWg = createProtocolServiceMock(Protocol.AMNEZIAWG, [
      createClientRecord({
        username: "alice",
        protocol: Protocol.AMNEZIAWG,
      }),
    ]);
    const amneziaWg2 = createProtocolServiceMock(Protocol.AMNEZIAWG2, [
      createClientRecord({
        username: "bob",
        protocol: Protocol.AMNEZIAWG2,
      }),
    ]);
    const amneziaWg3 = createProtocolServiceMock(Protocol.AMNEZIAWG3);
    const service = new ClientsService(
      xray.service,
      amneziaWg.service,
      amneziaWg2.service,
      amneziaWg3.service,
    );

    const clients = await service.getClients();

    expect(clients).toHaveLength(2);
    expect(clients.find(({ username }) => username === "alice")?.peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ protocol: Protocol.XRAY }),
        expect.objectContaining({ protocol: Protocol.AMNEZIAWG }),
      ]),
    );
    expect(clients.find(({ username }) => username === "bob")?.peers).toEqual([
      expect.objectContaining({ protocol: Protocol.AMNEZIAWG2 }),
    ]);
  });

  // Тестирование маршрутизации создания клиента в выбранный протокол
  it("routes client creation to the selected protocol", async () => {
    const { service, protocols } = createSubject();

    await expect(
      service.createClient({
        clientName: "alice",
        protocol: Protocol.AMNEZIAWG,
        expiresAt: 4_102_444_800,
      }),
    ).resolves.toMatchObject({
      protocol: Protocol.AMNEZIAWG,
    });
    expect(protocols.amneziaWg.spies.createClient).toHaveBeenCalledWith(
      "alice",
      { expiresAt: 4_102_444_800 },
    );
    expect(protocols.xray.spies.createClient).not.toHaveBeenCalled();
    expect(protocols.amneziaWg2.spies.createClient).not.toHaveBeenCalled();
  });

  // Тестирование запрета операций для выключенного протокола
  it("rejects client creation for a disabled protocol", async () => {
    const { service, protocols } = createSubject();
    appConfig.PROTOCOLS_ENABLED = [Protocol.XRAY];

    await expect(
      service.createClient({
        clientName: "alice",
        protocol: Protocol.AMNEZIAWG,
      }),
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(protocols.amneziaWg.spies.createClient).not.toHaveBeenCalled();
  });

  // Тестирование передачи параметров обновления сервису протокола
  it("forwards client updates to the selected protocol", async () => {
    const { service, protocols } = createSubject();

    await expect(
      service.updateClient({
        clientId: "client-id",
        protocol: Protocol.XRAY,
        status: PeerStatus.Disabled,
        expiresAt: 4_102_444_800,
      }),
    ).resolves.toBeUndefined();
    expect(protocols.xray.spies.updateClient).toHaveBeenCalledWith(
      "client-id",
      {
        status: PeerStatus.Disabled,
        expiresAt: 4_102_444_800,
      },
    );
  });

  // Тестирование ошибки при обновлении отсутствующего клиента
  it("returns not found when the protocol cannot update a client", async () => {
    const { service, protocols } = createSubject();
    protocols.xray.spies.updateClient.mockResolvedValue(false);

    await expect(
      service.updateClient({
        clientId: "missing-id",
        protocol: Protocol.XRAY,
        status: PeerStatus.Disabled,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // Тестирование ошибки при удалении отсутствующего клиента
  it("returns not found when the protocol cannot delete a client", async () => {
    const { service, protocols } = createSubject();
    protocols.amneziaWg.spies.deleteClient.mockResolvedValue(false);

    await expect(
      service.deleteClient({
        clientId: "missing-id",
        protocol: Protocol.AMNEZIAWG,
      }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  // Тестирование изоляции ошибки протокола при отключении просроченных клиентов
  it("continues disabling expired clients when one protocol fails", async () => {
    const { service, protocols } = createSubject();
    protocols.xray.spies.disableExpiredClients.mockResolvedValue(2);
    protocols.amneziaWg.spies.disableExpiredClients.mockRejectedValue(
      new Error("protocol unavailable"),
    );
    protocols.amneziaWg2.spies.disableExpiredClients.mockResolvedValue(1);

    await expect(service.disableExpiredClients()).resolves.toBe(3);
    expect(protocols.xray.spies.disableExpiredClients).toHaveBeenCalledOnce();
    expect(
      protocols.amneziaWg.spies.disableExpiredClients,
    ).toHaveBeenCalledOnce();
    expect(
      protocols.amneziaWg2.spies.disableExpiredClients,
    ).toHaveBeenCalledOnce();
  });

  // Тестирование ограничения количества пиров при создании клиентов в параллельных протоколах
  it("enforces the peer limit across concurrent protocol creates", async () => {
    const xray = createProtocolServiceMock(Protocol.XRAY, [
      createClientRecord({ username: "existing", protocol: Protocol.XRAY }),
    ]);
    const amneziaWg = createProtocolServiceMock(Protocol.AMNEZIAWG);
    const amneziaWg2 = createProtocolServiceMock(Protocol.AMNEZIAWG2);
    const amneziaWg3 = createProtocolServiceMock(Protocol.AMNEZIAWG3);
    const service = new ClientsService(
      xray.service,
      amneziaWg.service,
      amneziaWg2.service,
      amneziaWg3.service,
    );
    appConfig.SERVER_MAX_PEERS = TEST_SERVER_MAX_PEERS;

    const results = await Promise.allSettled([
      service.createClient({
        clientName: "first",
        protocol: Protocol.XRAY,
      }),
      service.createClient({
        clientName: "second",
        protocol: Protocol.AMNEZIAWG,
      }),
    ]);

    expect(results.map(({ status }) => status).sort()).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(results.find(({ status }) => status === "rejected")).toMatchObject({
      reason: { statusCode: 409 },
    });

    const createCalls =
      xray.spies.createClient.mock.calls.length +
      amneziaWg.spies.createClient.mock.calls.length +
      amneziaWg2.spies.createClient.mock.calls.length;
    expect(createCalls).toBe(1);
  });

  it("syncs AWG3 peer lifecycle events to EgressService when configured", async () => {
    const encoded = encodeVpnConfig({
      containers: [
        {
          container: "amnezia-awg2",
          awg: {
            last_config: JSON.stringify({
              client_ip: "10.90.0.4",
              config: "[Interface]\nAddress = 10.90.0.4/32\n",
            }),
          },
        },
      ],
    });

    const xray = createProtocolServiceMock(Protocol.XRAY);
    const amneziaWg = createProtocolServiceMock(Protocol.AMNEZIAWG);
    const amneziaWg2 = createProtocolServiceMock(Protocol.AMNEZIAWG2);
    const amneziaWg3 = createProtocolServiceMock(Protocol.AMNEZIAWG3, [
      createClientRecord({
        username: "carol",
        protocol: Protocol.AMNEZIAWG3,
        peers: [
          createClientPeer({
            id: "peer-3",
            protocol: Protocol.AMNEZIAWG3,
            allowedIps: ["10.90.0.4/32"],
          }),
        ],
      }),
    ]);
    amneziaWg3.spies.createClient.mockResolvedValue({
      id: "peer-3",
      config: encoded,
      protocol: Protocol.AMNEZIAWG3,
    });

    const upsertPeer = vi.fn(async () => null);
    const removePeer = vi.fn(async () => null);
    const egressStub = {
      isConfigured: () => true,
      upsertPeer,
      removePeer,
    } as unknown as EgressService;

    const service = new ClientsService(
      xray.service,
      amneziaWg.service,
      amneziaWg2.service,
      amneziaWg3.service,
      egressStub,
    );

    await service.createClient({
      clientName: "carol",
      protocol: Protocol.AMNEZIAWG3,
      egress: {
        exitIp: "203.0.113.20",
        dnsPrimary: "9.9.9.9",
        amneziaDnsDnat: true,
        enforceDnsDnat: false,
      },
    });
    expect(upsertPeer).toHaveBeenCalledWith({
      tunnelIpv4: "10.90.0.4",
      exitIp: "203.0.113.20",
      dnsPrimary: "9.9.9.9",
      amneziaDnsDnat: true,
      enforceDnsDnat: false,
      routingTableId: undefined,
      enabled: true,
    });

    await service.updateClient({
      clientId: "peer-3",
      protocol: Protocol.AMNEZIAWG3,
      status: PeerStatus.Disabled,
    });
    expect(removePeer).toHaveBeenCalledWith("10.90.0.4");

    await service.updateClient({
      clientId: "peer-3",
      protocol: Protocol.AMNEZIAWG3,
      status: PeerStatus.Active,
      egress: {
        exitIp: "198.51.100.10",
        enforceDnsDnat: true,
      },
    });
    expect(upsertPeer).toHaveBeenLastCalledWith({
      tunnelIpv4: "10.90.0.4",
      exitIp: "198.51.100.10",
      dnsPrimary: undefined,
      amneziaDnsDnat: false,
      enforceDnsDnat: true,
      routingTableId: undefined,
      enabled: true,
    });

    await service.deleteClient({
      clientId: "peer-3",
      protocol: Protocol.AMNEZIAWG3,
    });
    expect(removePeer).toHaveBeenCalledTimes(2);
    expect(removePeer).toHaveBeenLastCalledWith("10.90.0.4");
  });

  it("removes expired AWG3 peers from EgressService inside the protocol lock", async () => {
    const expiredAt = Math.floor(Date.now() / 1000) - 60;
    const activePeer = createClientPeer({
      id: "peer-active",
      protocol: Protocol.AMNEZIAWG3,
      allowedIps: ["10.90.0.2/32"],
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      status: PeerStatus.Active,
    });
    const expiredPeer = createClientPeer({
      id: "peer-expired",
      protocol: Protocol.AMNEZIAWG3,
      allowedIps: ["10.90.0.5/32"],
      expiresAt: expiredAt,
      status: PeerStatus.Active,
    });

    let currentPeers = [activePeer, expiredPeer];
    const amneziaWg3 = createProtocolServiceMock(Protocol.AMNEZIAWG3);
    amneziaWg3.spies.getClients.mockImplementation(async () => [
      createClientRecord({
        username: "dave",
        protocol: Protocol.AMNEZIAWG3,
        peers: currentPeers,
      }),
    ]);
    amneziaWg3.spies.disableExpiredClients.mockImplementation(async () => {
      currentPeers = [
        activePeer,
        {
          ...expiredPeer,
          allowedIps: ["0.0.0.0/32"],
          status: PeerStatus.Disabled,
        },
      ];
      return 1;
    });

    const removePeer = vi.fn(async () => null);
    const egressStub = {
      isConfigured: () => true,
      upsertPeer: vi.fn(async () => null),
      removePeer,
    } as unknown as EgressService;

    const service = new ClientsService(
      createProtocolServiceMock(Protocol.XRAY).service,
      createProtocolServiceMock(Protocol.AMNEZIAWG).service,
      createProtocolServiceMock(Protocol.AMNEZIAWG2).service,
      amneziaWg3.service,
      egressStub,
    );

    const disabledCount = await service.disableExpiredClients();
    expect(disabledCount).toBe(1);
    expect(removePeer).toHaveBeenCalledTimes(1);
    expect(removePeer).toHaveBeenCalledWith("10.90.0.5");
  });

  it("serializes AWG3 egress peer updates with protocol mutations to prevent reordering", async () => {
    const events: string[] = [];
    const amneziaWg3 = createProtocolServiceMock(Protocol.AMNEZIAWG3, [
      createClientRecord({
        username: "eve",
        protocol: Protocol.AMNEZIAWG3,
        peers: [
          createClientPeer({
            id: "peer-eve",
            protocol: Protocol.AMNEZIAWG3,
            allowedIps: ["10.90.0.6/32"],
          }),
        ],
      }),
    ]);
    amneziaWg3.spies.createClient.mockImplementation(async () => {
      events.push("create:start");
      await new Promise((r) => setTimeout(r, 15));
      events.push("create:end");
      return {
        id: "peer-new",
        config: "[Interface]\nAddress = 10.90.0.6/32\n",
        protocol: Protocol.AMNEZIAWG3,
      };
    });
    amneziaWg3.spies.deleteClient.mockImplementation(async () => {
      events.push("delete:start");
      await new Promise((r) => setTimeout(r, 10));
      events.push("delete:end");
      return true;
    });

    const egressStub = {
      isConfigured: () => true,
      upsertPeer: vi.fn(async () => {
        events.push("egress:upsert");
        return null;
      }),
      removePeer: vi.fn(async () => {
        events.push("egress:remove");
        return null;
      }),
    } as unknown as EgressService;

    const service = new ClientsService(
      createProtocolServiceMock(Protocol.XRAY).service,
      createProtocolServiceMock(Protocol.AMNEZIAWG).service,
      createProtocolServiceMock(Protocol.AMNEZIAWG2).service,
      amneziaWg3.service,
      egressStub,
    );

    const createPromise = service.createClient({
      clientName: "eve",
      protocol: Protocol.AMNEZIAWG3,
      egress: { exitIp: "198.51.100.10" },
    });
    await new Promise((r) => setTimeout(r, 5));
    const deletePromise = service.deleteClient({
      clientId: "peer-eve",
      protocol: Protocol.AMNEZIAWG3,
    });
    await Promise.all([createPromise, deletePromise]);

    expect(events).toEqual([
      "create:start",
      "create:end",
      "egress:upsert",
      "delete:start",
      "delete:end",
      "egress:remove",
    ]);
  });

  it("re-enables a disabled 0.0.0.0/32 peer and deletes a disabled peer using saved tunnel IPv4", async () => {
    let peerAllowedIps = ["0.0.0.0/32"];
    const amneziaWg3 = createProtocolServiceMock(Protocol.AMNEZIAWG3);
    amneziaWg3.spies.getClients.mockImplementation(async () => [
      createClientRecord({
        username: "frank",
        protocol: Protocol.AMNEZIAWG3,
        peers: [
          createClientPeer({
            id: "peer-frank",
            protocol: Protocol.AMNEZIAWG3,
            allowedIps: peerAllowedIps,
            status:
              peerAllowedIps[0] === "0.0.0.0/32"
                ? PeerStatus.Disabled
                : PeerStatus.Active,
          }),
        ],
      }),
    ]);
    amneziaWg3.spies.updateClient.mockImplementation(async (_id, opts) => {
      peerAllowedIps =
        opts.status === PeerStatus.Disabled ? ["0.0.0.0/32"] : ["10.90.0.15/32"];
      return true;
    });
    amneziaWg3.service.getClientTunnelIpv4 = vi.fn(async () => "10.90.0.15");

    const upsertPeer = vi.fn(async () => null);
    const removePeer = vi.fn(async () => null);
    const egressStub = {
      isConfigured: () => true,
      upsertPeer,
      removePeer,
    } as unknown as EgressService;

    const service = new ClientsService(
      createProtocolServiceMock(Protocol.XRAY).service,
      createProtocolServiceMock(Protocol.AMNEZIAWG).service,
      createProtocolServiceMock(Protocol.AMNEZIAWG2).service,
      amneziaWg3.service,
      egressStub,
    );

    await service.updateClient({
      clientId: "peer-frank",
      protocol: Protocol.AMNEZIAWG3,
      status: PeerStatus.Active,
      egress: { exitIp: "198.51.100.10", dnsPrimary: "1.1.1.1" },
    });
    expect(upsertPeer).toHaveBeenCalledWith(
      expect.objectContaining({ tunnelIpv4: "10.90.0.15", enabled: true }),
    );

    peerAllowedIps = ["0.0.0.0/32"];
    await service.deleteClient({
      clientId: "peer-frank",
      protocol: Protocol.AMNEZIAWG3,
    });
    expect(removePeer).toHaveBeenCalledWith("10.90.0.15");
  });
});
