import { statfs } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import type { HostMetrics } from "./types.js";

const cpuTimes = () =>
  cpus().reduce(
    ({ idle, total }, { times }) => ({
      idle: idle + times.idle,
      total: total + times.user + times.nice + times.sys + times.idle + times.irq,
    }),
    { idle: 0, total: 0 },
  );

export const createHostMetricsSampler = (diskPath: string) => {
  let previous = cpuTimes();
  return async (): Promise<HostMetrics> => {
    const current = cpuTimes();
    const total = current.total - previous.total;
    const idle = current.idle - previous.idle;
    previous = current;
    const disk = await statfs(diskPath).catch(() => null);
    const usedBlocks = disk ? disk.blocks - disk.bfree : 0;
    const usableBlocks = disk ? usedBlocks + disk.bavail : 0;

    return {
      cpuUsedPercent: total > 0 && idle >= 0 && idle <= total
        ? Math.round(((total - idle) * 100) / total)
        : null,
      memoryFreeBytes: freemem(),
      memoryTotalBytes: totalmem(),
      diskAvailableBytes: disk ? disk.bavail * disk.bsize : null,
      diskUsedPercent: usableBlocks > 0 ? Math.ceil((usedBlocks * 100) / usableBlocks) : null,
    };
  };
};
