// Live process stats for `ping`: uptime, memory, CPU, gateway counters.

import { arch, freemem, loadavg, platform, totalmem } from "node:os";

/** Wall-clock start of this process (module load is ~immediately after boot). */
export const startedAt = Date.now();

/** Simple in-memory tallies since boot. Reset on restart, by design. */
export const counters = {
  messages: 0,
  pings: 0,
  runs: 0,
  compiles: 0,
  errors: 0,
};

export interface ProcessSnapshot {
  uptimeMs: number;
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  cpuUserSec: number;
  cpuSystemSec: number;
  hostTotalMem: number;
  hostFreeMem: number;
  /** 1/5/15-minute load averages (host-wide; zeros where unsupported). */
  loadAvg: number[];
  platform: string;
  arch: string;
  bunVersion: string;
  pid: number;
}

/** Fresh readings on every call — call inside the ping handler, not at boot. */
export function snapshot(): ProcessSnapshot {
  const mem = process.memoryUsage();
  const cpu = process.cpuUsage();
  return {
    uptimeMs: Date.now() - startedAt,
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers ?? 0,
    cpuUserSec: cpu.user / 1_000_000,
    cpuSystemSec: cpu.system / 1_000_000,
    hostTotalMem: totalmem(),
    hostFreeMem: freemem(),
    loadAvg: loadavg(),
    platform: platform(),
    arch: arch(),
    bunVersion: process.versions.bun ?? "unknown",
    pid: process.pid,
  };
}
// i wonder if i should speak so much
/** "1d 2h 3m" / "2h 14m 3s" / "45s" — trailing unit omitted when zero. */
export function formatDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / 1000));
  const days = Math.floor(totalSec / 86_400);
  const hours = Math.floor((totalSec % 86_400) / 3_600);
  const minutes = Math.floor((totalSec % 3_600) / 60);
  const seconds = totalSec % 60;
  if (days > 0) return `${days}d ${hours}h ${minutes}m`;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(1)} ${units[unit]}`;
}
