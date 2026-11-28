import { inflateSync } from "zlib";
import {
  ClientRecord,
  IProtocolService,
  PeerStatus,
  CreateClientResult,
  CreateClientPayload,
  DeleteClientPayload,
  UpdateClientPayload,
} from "@/types/clients";
import { Mutex } from "@/utils/mutex";
import { Protocol } from "@/types/shared";
import { APIError } from "@/utils/APIError";
import appConfig from "@/constants/appConfig";
import { appLogger } from "@/config/winstonLogger";
import { EgressService } from "@/services/egress";
import { ClientErrorCode, ServerErrorCode } from "@/types/shared";
import { resolveEnabledProtocols } from "@/helpers/resolveEnabledProtocols";

const IPV4_CIDR_RE = /^(\d{1,3}(?:\.\d{1,3}){3})(?:\/\d+)?$/;

const extractPeerIpv4 = (allowedIps: string[]): string | null => {
  for (const allowed of allowedIps) {
    const match = IPV4_CIDR_RE.exec(allowed.trim());
    if (match?.[1] && match[1] !== "0.0.0.0") {
      return match[1];
    }
  }
  return null;
};

/** Extract the peer's inner /32 tunnel IPv4 from a vpn:// bundle or wg INI string. */
const extractTunnelIpv4FromConfig = (config: string): string | null => {
  try {
    if (config.startsWith("vpn://")) {
      const b64 = config
        .slice("vpn://".length)
        .replace(/-/g, "+")
        .replace(/_/g, "/");
      const raw = Buffer.from(b64, "base64");
      if (raw.length <= 4) return null;
      const inflated = inflateSync(raw.subarray(4)).toString("utf8");
      const serverJson = JSON.parse(inflated) as {
        containers?: Array<{ awg?: { last_config?: string } }>;
      };
      const lastConfigStr = serverJson.containers?.[0]?.awg?.last_config;
      if (typeof lastConfigStr === "string") {
        const lastConfig = JSON.parse(lastConfigStr) as {
          client_ip?: string;
          config?: string;
        };
        if (typeof lastConfig.client_ip === "string") {
          const match = IPV4_CIDR_RE.exec(lastConfig.client_ip.trim());
          if (match?.[1]) return match[1];
        }
        if (typeof lastConfig.config === "string") {
          const addrMatch = /^Address\s*=\s*(\d{1,3}(?:\.\d{1,3}){3})/m.exec(
            lastConfig.config,
          );
          if (addrMatch?.[1]) return addrMatch[1];
        }
      }
      return null;
    }

    const addrMatch = /^Address\s*=\s*(\d{1,3}(?:\.\d{1,3}){3})/m.exec(config);
    return addrMatch?.[1] ?? null;
  } catch {
    return null;
  }
};

/**
 * Сервис для работы с клиентами
 */
export class ClientsService {
  static key = "clientsService";

  // Маршрутизация протокол -> сервис
  private readonly servicesByProtocol: Record<Protocol, IProtocolService>;

  constructor(
    private xrayService: IProtocolService,
    private amneziaWgService: IProtocolService,
    private amneziaWg2Service: IProtocolService,
    private amneziaWg3Service: IProtocolService,
    private readonly egressService?: EgressService,
  ) {
    this.servicesByProtocol = {
      [Protocol.XRAY]: this.xrayService,
      [Protocol.AMNEZIAWG]: this.amneziaWgService,
      [Protocol.AMNEZIAWG2]: this.amneziaWg2Service,
      [Protocol.AMNEZIAWG3]: this.amneziaWg3Service,
    };
  }

  // Мьютексы на запись по протоколам. сериализуют read-modify-write
  // над wg0.conf / clientsTable / server.json, чтобы параллельные
  // create/update/delete/disable не затирали друг друга и не выбирали один IP
  private readonly writeLocks = new Map<Protocol, Mutex>();
  private readonly createLock = new Mutex();

  /**
   * Получить мьютекс записи для протокола
   */
  private lockFor(protocol: Protocol): Mutex {
    let mutex = this.writeLocks.get(protocol);

    if (!mutex) {
      mutex = new Mutex();
      this.writeLocks.set(protocol, mutex);
    }

    return mutex;
  }

  runWithProtocolLock<T>(protocol: Protocol, fn: () => Promise<T>): Promise<T> {
    return this.lockFor(protocol).runExclusive(fn);
  }

  /**
   * Получить список включенных протоколов
   */
  private async getEnabledProtocols(): Promise<Protocol[]> {
    if (appConfig.PROTOCOLS_ENABLED?.length) {
      return appConfig.PROTOCOLS_ENABLED;
    }

    const enabled = await resolveEnabledProtocols();

    if (!enabled.length) {
      throw new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
        msg: "swagger.errors.NO_PROTOCOLS_AVAILABLE",
      });
    }

    return enabled;
  }

  /**
   * Проверить, что протокол включен
   */
  private async ensureProtocolEnabled(protocol: Protocol): Promise<void> {
    const enabled = await this.getEnabledProtocols();

    if (!enabled.includes(protocol)) {
      throw new APIError(ClientErrorCode.BAD_REQUEST);
    }
  }

  /**
   * Получить сервис по протоколу
   */
  private getServiceByProtocol(protocol: Protocol): IProtocolService {
    const service = this.servicesByProtocol[protocol];

    if (!service) {
      throw new APIError(ServerErrorCode.NOT_IMPLEMENTED);
    }

    return service;
  }

  private async findAwg3PeerIpv4(clientId: string): Promise<string | null> {
    try {
      const records = await this.amneziaWg3Service.getClients();
      for (const record of records) {
        const peer = record.peers.find((item) => item.id === clientId);
        if (!peer) continue;
        const ipv4 = extractPeerIpv4(peer.allowedIps);
        if (ipv4) return ipv4;
      }
      const fallback = await this.amneziaWg3Service.getClientTunnelIpv4?.(clientId);
      if (fallback && fallback !== "0.0.0.0") {
        return fallback;
      }
    } catch (error) {
      appLogger.warn(`Failed to resolve AWG3 peer IPv4 for ${clientId}: ${error}`);
    }
    return null;
  }

  /**
   * Получить список клиентов
   */
  async getClients(): Promise<ClientRecord[]> {
    const enabled = await this.getEnabledProtocols();
    const clients = new Map<string, ClientRecord>();

    for (const protocol of enabled) {
      const service = this.getServiceByProtocol(protocol);

      const serviceClients = await service.getClients();

      for (const client of serviceClients) {
        const normalizedPeers = client.peers.map((peer) => ({
          ...peer,
          protocol: peer.protocol ?? protocol,
        }));

        const existing = clients.get(client.username);

        if (existing) {
          existing.peers.push(...normalizedPeers);
        } else {
          clients.set(client.username, {
            username: client.username,
            peers: normalizedPeers,
          });
        }
      }
    }

    return Array.from(clients.values());
  }

  /**
   * Создать клиента
   */
  async createClient({
    clientName,
    protocol,
    expiresAt = null,
    egress,
  }: CreateClientPayload): Promise<CreateClientResult> {
    return this.createLock.runExclusive(async () => {
      await this.ensureProtocolEnabled(protocol);

      const maxPeers = appConfig.SERVER_MAX_PEERS;
      if (maxPeers) {
        const clients = await this.getClients();
        const currentPeers = clients.reduce(
          (total, client) => total + client.peers.length,
          0,
        );

        if (currentPeers >= maxPeers) {
          throw new APIError(ClientErrorCode.CONFLICT);
        }
      }

      const service = this.getServiceByProtocol(protocol);

      return this.lockFor(protocol).runExclusive(async () => {
        const result = await service.createClient(clientName, { expiresAt });

        if (
          protocol === Protocol.AMNEZIAWG3 &&
          egress &&
          this.egressService?.isConfigured()
        ) {
          const tunnelIpv4 =
            extractTunnelIpv4FromConfig(result.config) ??
            (await this.findAwg3PeerIpv4(result.id));
          if (tunnelIpv4) {
            await this.egressService.upsertPeer({
              tunnelIpv4,
              exitIp: egress.exitIp,
              dnsPrimary: egress.dnsPrimary,
              amneziaDnsDnat: egress.amneziaDnsDnat ?? false,
              enforceDnsDnat: egress.enforceDnsDnat ?? false,
              routingTableId: egress.routingTableId,
              enabled: true,
            });
          }
        }

        return result;
      });
    });
  }

  /**
   * Удалить клиента
   */
  async deleteClient({
    clientId,
    protocol,
  }: DeleteClientPayload): Promise<void> {
    await this.ensureProtocolEnabled(protocol);

    const service = this.getServiceByProtocol(protocol);
    const shouldSyncEgress =
      protocol === Protocol.AMNEZIAWG3 &&
      Boolean(this.egressService?.isConfigured());

    await this.lockFor(protocol).runExclusive(async () => {
      const tunnelIpv4 = shouldSyncEgress
        ? await this.findAwg3PeerIpv4(clientId)
        : null;

      const ok = await service.deleteClient(clientId);

      if (!ok) {
        throw new APIError(ClientErrorCode.NOT_FOUND);
      }

      if (tunnelIpv4 && this.egressService) {
        await this.egressService.removePeer(tunnelIpv4);
      }
    });
  }

  /**
   * Обновить expiresAt клиента
   */
  async updateClient({
    clientId,
    protocol,
    expiresAt,
    status,
    egress,
  }: UpdateClientPayload): Promise<void> {
    await this.ensureProtocolEnabled(protocol);

    const service = this.getServiceByProtocol(protocol);
    const isDisabling =
      status === PeerStatus.Disabled ||
      (status !== PeerStatus.Active &&
        expiresAt !== undefined &&
        expiresAt !== null &&
        expiresAt <= Math.floor(Date.now() / 1000));
    const shouldSyncEgress =
      protocol === Protocol.AMNEZIAWG3 &&
      Boolean(this.egressService?.isConfigured()) &&
      (status !== undefined || expiresAt !== undefined || egress !== undefined);

    await this.lockFor(protocol).runExclusive(async () => {
      const beforeIpv4 = shouldSyncEgress
        ? await this.findAwg3PeerIpv4(clientId)
        : null;

      const ok = await service.updateClient(clientId, {
        expiresAt,
        status,
      });

      if (!ok) {
        throw new APIError(ClientErrorCode.NOT_FOUND);
      }

      if (shouldSyncEgress && this.egressService) {
        const tunnelIpv4 =
          beforeIpv4 ?? (await this.findAwg3PeerIpv4(clientId));
        if (tunnelIpv4) {
          if (isDisabling) {
            await this.egressService.removePeer(tunnelIpv4);
          } else if (egress) {
            await this.egressService.upsertPeer({
              tunnelIpv4,
              exitIp: egress.exitIp,
              dnsPrimary: egress.dnsPrimary,
              amneziaDnsDnat: egress.amneziaDnsDnat ?? false,
              enforceDnsDnat: egress.enforceDnsDnat ?? false,
              routingTableId: egress.routingTableId,
              enabled: true,
            });
          }
        }
      }
    });
  }

  /**
   * Заблокировать (отключить) всех клиентов с истекшим сроком действия
   * Записи не удаляются, клиентам блокируется доступ
   */
  async disableExpiredClients(): Promise<number> {
    const enabled = await this.getEnabledProtocols();

    let disabled = 0;

    for (const protocol of enabled) {
      const service = this.servicesByProtocol[protocol];
      if (!service) continue;

      try {
        disabled += await this.lockFor(protocol).runExclusive(async () => {
          const shouldSyncEgress =
            protocol === Protocol.AMNEZIAWG3 &&
            Boolean(this.egressService?.isConfigured());
          const nowSec = Math.floor(Date.now() / 1000);
          const activeBefore = new Map<
            string,
            { ipv4: string; expiresAt: number | null }
          >();

          if (shouldSyncEgress) {
            try {
              const records = await service.getClients();
              for (const record of records) {
                for (const peer of record.peers) {
                  if (peer.status !== PeerStatus.Active) continue;
                  const ipv4 = extractPeerIpv4(peer.allowedIps);
                  if (ipv4) {
                    activeBefore.set(peer.id, {
                      ipv4,
                      expiresAt: peer.expiresAt,
                    });
                  }
                }
              }
            } catch (error) {
              appLogger.warn(
                `Failed to snapshot AWG3 peers before expiration cleanup: ${error}`,
              );
            }
          }

          const count = await service.disableExpiredClients();

          if (
            count > 0 &&
            shouldSyncEgress &&
            this.egressService &&
            activeBefore.size > 0
          ) {
            const ipsToRemove = new Set<string>();
            try {
              const afterRecords = await service.getClients();
              for (const record of afterRecords) {
                for (const peer of record.peers) {
                  const prev = activeBefore.get(peer.id);
                  if (!prev) continue;
                  if (
                    peer.status === PeerStatus.Disabled ||
                    extractPeerIpv4(peer.allowedIps) === null
                  ) {
                    ipsToRemove.add(prev.ipv4);
                  }
                }
              }
            } catch (error) {
              appLogger.warn(
                `Failed to inspect AWG3 peers after expiration cleanup: ${error}`,
              );
            }
            for (const prev of activeBefore.values()) {
              if (prev.expiresAt !== null && prev.expiresAt <= nowSec) {
                ipsToRemove.add(prev.ipv4);
              }
            }
            for (const tunnelIpv4 of ipsToRemove) {
              await this.egressService.removePeer(tunnelIpv4);
            }
          }

          return count;
        });
      } catch {
        appLogger.warn(
          `${protocol}: сервис недоступен, пропускаем блокировку просроченных клиентов`,
        );
      }
    }

    return disabled;
  }
}
