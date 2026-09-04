import os from "os";
import {
  AwgInterfaceState,
  ServerLoadPayload,
  ServerBackupPayload,
  ServerStatusPayload,
  ServerLoadDockerContainerStats,
} from "@/types/server";
import fs from "fs/promises";
import {
  parseNetIo,
  parseMemUsage,
  parseCpuPercent,
} from "@/helpers/dockerStats";
import { parseCgroupPids, parseMemInfo } from "@/helpers/hostMetrics";
import { APIError } from "@/utils/APIError";
import appConfig from "@/constants/appConfig";
import { XrayService } from "@/services/xray";
import { AppContract } from "@/contracts/app";
import { isNotNull } from "@/utils/primitive";
import { TimeContract } from "@/contracts/time";
import { appLogger } from "@/config/winstonLogger";
import { ClientsService } from "@/services/clients";
import { AmneziaWgService } from "@/services/amneziaWg";
import { AmneziaWg2Service } from "@/services/amneziaWg2";
import { AmneziaWg3Service } from "@/services/amneziaWg3";
import { AmneziaWgServiceBase } from "@/services/amneziaWgShared/amneziaWgServiceBase";
import { ServerConnection } from "@/helpers/serverConnection";
import { listRunningDockerContainers } from "@/helpers/docker";
import { resolveEnabledProtocols } from "@/helpers/resolveEnabledProtocols";
import { Protocol, ClientErrorCode, ServerErrorCode } from "@/types/shared";
import {
  SUPPORTED_ASSERTION_TYPES,
  SUPPORTED_PROBE_KINDS,
} from "@/services/checks";

/**
 * Сервис управления сервером
 */
export class ServerService {
  static key = "serverService";

  private readonly server: ServerConnection;

  constructor(
    private readonly xrayService: XrayService,
    private readonly clientsService: ClientsService,
    private readonly amneziaWgService: AmneziaWgService,
    private readonly amneziaWg2Service: AmneziaWg2Service,
    private readonly amneziaWg3Service: AmneziaWg3Service,
  ) {
    this.server = new ServerConnection();
  }

  /**
   * Получить агрегированную информацию о сервере
   */
  async getServerStatus(): Promise<ServerStatusPayload> {
    const clients = await this.clientsService.getClients();
    const protocols = await resolveEnabledProtocols();
    const interfaces = await this.getAwgInterfaceStates(protocols);

    // The UDP ports clients actually dial. Reported so the panel can say "this
    // node serves 51890" without an operator reading compose.yaml on the host,
    // and so a node whose port was changed locally stops being a mystery.
    const listenPorts = [
      ...new Set(
        Object.values(interfaces)
          .map((state) => state.listenPort)
          .filter((port): port is number => port !== null),
      ),
    ].sort((a, b) => a - b);

    return {
      id: appConfig.SERVER_ID || "",
      region: appConfig.SERVER_REGION || "",
      weight: appConfig.SERVER_WEIGHT || 0,
      maxPeers: appConfig.SERVER_MAX_PEERS || 0,
      totalPeers: clients.reduce((acc, client) => acc + client.peers.length, 0),
      protocols,
      publicHost: appConfig.SERVER_PUBLIC_HOST || "",
      listenPorts,
      // Read from the registries themselves, never written out by hand: a
      // hand-kept list is a list that eventually advertises a rule this agent
      // cannot run, which is the one failure the whole design has to prevent.
      checkCapabilities: {
        probeKinds: SUPPORTED_PROBE_KINDS,
        assertionTypes: SUPPORTED_ASSERTION_TYPES,
      },
    };
  }

  /**
   * Live interface state for the AWG protocols this node actually runs. Only
   * amneziawg2 and amneziawg3 are asked: the panel models those two, and
   * probing a protocol the node does not serve would turn a normal shape into
   * a logged error on every poll.
   */
  private async getAwgInterfaceStates(
    protocols: Protocol[],
  ): Promise<Partial<Record<Protocol, AwgInterfaceState>>> {
    const services: Partial<Record<Protocol, AmneziaWgServiceBase>> = {
      [Protocol.AMNEZIAWG2]: this.amneziaWg2Service,
      [Protocol.AMNEZIAWG3]: this.amneziaWg3Service,
    };
    const wanted = protocols.filter((protocol) => services[protocol]);
    const states = await Promise.all(
      wanted.map(async (protocol) => {
        const service = services[protocol];
        if (!service) return null;
        try {
          return [protocol, await service.getInterfaceState()] as const;
        } catch (error) {
          // One unreachable container must not cost the whole metrics call.
          appLogger.warn(
            `Не удалось получить состояние интерфейса ${protocol}: ${error}`,
          );
          return null;
        }
      }),
    );

    return Object.fromEntries(states.filter(isNotNull));
  }

  /**
   * Сформировать резервную копию конфигурации сервера
   */
  async exportBackup(): Promise<ServerBackupPayload> {
    const protocols = await resolveEnabledProtocols();

    if (!protocols.length) {
      throw new APIError(ServerErrorCode.SERVICE_UNAVAILABLE, {
        msg: "swagger.errors.NO_PROTOCOLS_AVAILABLE",
      });
    }

    const payload: ServerBackupPayload = {
      generatedAt: new Date().toISOString(),
      serverId: appConfig.SERVER_ID ?? null,
      protocols,
    };

    if (protocols.includes(Protocol.AMNEZIAWG)) {
      payload.amnezia = await this.amneziaWgService.exportBackup();
    }

    if (protocols.includes(Protocol.AMNEZIAWG2)) {
      payload.amneziaWg2 = await this.amneziaWg2Service.exportBackup();
    }

    if (protocols.includes(Protocol.AMNEZIAWG3)) {
      payload.amneziaWg3 = await this.amneziaWg3Service.exportBackup();
    }

    if (protocols.includes(Protocol.XRAY)) {
      payload.xray = await this.xrayService.exportBackup();
    }

    return payload;
  }

  /**
   * Получить метрики нагрузки сервера
   */
  async getServerLoad(): Promise<ServerLoadPayload> {
    const timestamp = new Date().toISOString();

    // CPU / Load
    const cores = Math.max(1, os.cpus()?.length ?? 1);
    const loadavg = os.loadavg() as [number, number, number];

    // RAM
    const totalBytes = os.totalmem();
    const freeBytes = os.freemem();
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    // Disk (df -kP /)
    const disk = await (async () => {
      try {
        const { stdout } = await this.server.run("df -kP /", {
          timeout: 1.5 * TimeContract.SECOND,
        });
        const lines = stdout
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean);
        if (lines.length < 2) return null;

        // Filesystem 1024-blocks Used Available Capacity Mounted on
        const cols = lines[1].split(/\s+/);
        if (cols.length < 6) return null;

        const totalKb = Number(cols[1]);
        const usedKb = Number(cols[2]);
        const availKb = Number(cols[3]);
        const percentRaw = String(cols[4] || "").trim();
        const usedPercent = Number(percentRaw.replace("%", "")) || 0;

        if (![totalKb, usedKb, availKb].every((n) => Number.isFinite(n))) {
          return null;
        }

        return {
          totalBytes: totalKb * 1024,
          usedBytes: usedKb * 1024,
          availableBytes: availKb * 1024,
          usedPercent,
        };
      } catch {
        return null;
      }
    })();

    // Network totals (/proc/net/dev)
    const network = await (async () => {
      try {
        const raw = await fs.readFile("/proc/net/dev", "utf-8");
        const lines = raw
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .slice(2); // пропускаем заголовки

        let rxBytes = 0;
        let txBytes = 0;

        for (const line of lines) {
          const [ifaceRaw, restRaw] = line.split(":");
          const iface = (ifaceRaw || "").trim();
          const rest = (restRaw || "").trim();
          if (!iface || !rest || iface === "lo") continue;

          const parts = rest.split(/\s+/);

          // rx bytes = parts[0], tx bytes = parts[8]
          const rx = Number(parts[0] || 0);
          const tx = Number(parts[8] || 0);
          if (Number.isFinite(rx)) rxBytes += rx;
          if (Number.isFinite(tx)) txBytes += tx;
        }

        return { rxBytes, txBytes };
      } catch {
        return null;
      }
    })();

    // Docker (опционально)
    const docker = await (async () => {
      const containers = [
        AppContract.AmneziaWG.DOCKER_CONTAINER,
        AppContract.AmneziaWG2.DOCKER_CONTAINER,
        AppContract.AmneziaWG3.DOCKER_CONTAINER,
        AppContract.Xray.DOCKER_CONTAINER,
      ].filter(Boolean);

      if (!containers.length) return null;

      try {
        const running = await listRunningDockerContainers();

        const targets = containers.filter((name) => running.has(name));
        if (!targets.length) return null;

        // Один вызов на все контейнеры
        const cmd = `docker stats --no-stream --format "{{.Name}}\\t{{.CPUPerc}}\\t{{.MemUsage}}\\t{{.NetIO}}\\t{{.PIDs}}" ${targets.join(" ")}`;
        const { stdout } = await this.server.run(cmd, {
          timeout: 10 * TimeContract.SECOND,
          maxBufferBytes: 1024 * 1024,
        });

        // Разбираем строку статистики одного контейнера
        const parseLine = (
          line: string,
        ): ServerLoadDockerContainerStats | null => {
          const parts = line.split("\t");
          if (parts.length < 5) return null;

          const name = (parts[0] || "").trim();
          if (!name) return null;

          const memParsed = parseMemUsage(parts[2] || "");
          const netParsed = parseNetIo(parts[3] || "");
          const pidsNumber = Number((parts[4] || "").trim());

          return {
            name,
            cpuPercent: parseCpuPercent(parts[1] || ""),
            memUsageBytes: memParsed.usage,
            memLimitBytes: memParsed.limit,
            netRxBytes: netParsed.rx,
            netTxBytes: netParsed.tx,
            pids: Number.isFinite(pidsNumber) ? pidsNumber : null,
          };
        };

        const stats = stdout
          .split("\n")
          .map((x) => x.trim())
          .filter(Boolean)
          .map(parseLine)
          .filter(isNotNull);

        if (!stats.length) return null;

        return { containers: stats };
      } catch (err) {
        appLogger.warn(`Не удалось получить статистику Docker: ${err}`);
        return null;
      }
    })();

    // What the kernel says is actually usable, and the swap that backs it.
    // os.freemem() is not this number on any host with a page cache, and the
    // node's own deploy gate reads MemAvailable - so the panel must read the
    // same thing or the two will disagree about whether a node is healthy.
    const memInfo = await (async () => {
      try {
        return parseMemInfo(await fs.readFile("/proc/meminfo", "utf-8"));
      } catch {
        return {
          availableBytes: null,
          swapTotalBytes: null,
          swapFreeBytes: null,
        };
      }
    })();

    // The cgroup task budget of the agent's own container. On a small host this
    // is what runs out first, and a container that cannot fork looks healthy
    // and low on memory the whole time it is wedged.
    const pids = await (async () => {
      try {
        const [current, max] = await Promise.all([
          fs.readFile("/sys/fs/cgroup/pids.current", "utf-8"),
          fs.readFile("/sys/fs/cgroup/pids.max", "utf-8"),
        ]);
        return parseCgroupPids(current, max);
      } catch {
        return { pidsCurrent: null, pidsMax: null };
      }
    })();

    const interfaces = await this.getAwgInterfaceStates(
      await resolveEnabledProtocols(),
    );
    const awgEntry = (protocol: Protocol) => {
      const state = interfaces[protocol];
      return state ? { up: state.up, peers: state.peers } : null;
    };

    const payload: ServerLoadPayload = {
      timestamp,
      uptimeSec: os.uptime(),
      loadavg,
      cpu: { cores },
      memory: {
        totalBytes,
        freeBytes,
        usedBytes,
        availableBytes: memInfo.availableBytes,
      },
      swap:
        memInfo.swapTotalBytes === null
          ? null
          : {
              totalBytes: memInfo.swapTotalBytes,
              usedBytes:
                memInfo.swapFreeBytes === null
                  ? null
                  : Math.max(0, memInfo.swapTotalBytes - memInfo.swapFreeBytes),
            },
      agent: { pidsCurrent: pids.pidsCurrent, pidsMax: pids.pidsMax },
      awg: {
        amneziawg2: awgEntry(Protocol.AMNEZIAWG2),
        amneziawg3: awgEntry(Protocol.AMNEZIAWG3),
      },
      disk,
      network,
      docker,
    };

    return payload;
  }

  /**
   * Импортировать данные резервной копии сервера
   */
  async importBackup(payload: ServerBackupPayload): Promise<void> {
    const protocols = payload.protocols ?? [];

    if (!protocols.length) {
      throw new APIError(ClientErrorCode.BAD_REQUEST);
    }

    if (protocols.includes(Protocol.AMNEZIAWG)) {
      if (!payload.amnezia) {
        throw new APIError(ClientErrorCode.BAD_REQUEST);
      }

      await this.amneziaWgService.importBackup(payload.amnezia);
    }

    if (protocols.includes(Protocol.AMNEZIAWG2)) {
      if (!payload.amneziaWg2) {
        throw new APIError(ClientErrorCode.BAD_REQUEST);
      }

      await this.amneziaWg2Service.importBackup(payload.amneziaWg2);
    }

    if (protocols.includes(Protocol.AMNEZIAWG3)) {
      if (!payload.amneziaWg3) {
        throw new APIError(ClientErrorCode.BAD_REQUEST);
      }

      await this.amneziaWg3Service.importBackup(payload.amneziaWg3);
    }

    if (protocols.includes(Protocol.XRAY)) {
      if (!payload.xray) {
        throw new APIError(ClientErrorCode.BAD_REQUEST);
      }

      await this.xrayService.importBackup(payload.xray);
    }
  }

  /**
   * Перезагрузить сервер
   */
  async rebootServer(): Promise<void> {
    try {
      appLogger.info("Перезагрузка сервера...");
      await this.server.run("sudo reboot", {
        timeout: 1.5 * TimeContract.SECOND,
      });
    } catch (err) {
      appLogger.warn(`При перезагрузке сервера произошла ошибка: ${err}`);
    }
  }
}
