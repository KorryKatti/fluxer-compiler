import { join } from "node:path";

export interface FunConfig {
  channelId: string;
  enabled: boolean;
}

const CONFIG_PATH = join(import.meta.dir, "..", "data", "fun.json");

let config: FunConfig = {
  channelId: process.env.FUN_CHANNEL_ID ?? "",
  enabled: true,
};

function normalizeConfig(raw: unknown): FunConfig {
  const obj = raw && typeof raw === "object" ? (raw as Record<string, unknown>) : {};
  const channelId =
    typeof obj.channelId === "string" && obj.channelId.length > 0
      ? obj.channelId
      : (process.env.FUN_CHANNEL_ID ?? "");
  const enabled = typeof obj.enabled === "boolean" ? obj.enabled : true;
  return { channelId, enabled };
}

export async function loadFunConfig(): Promise<void> {
  try {
    const raw = await Bun.file(CONFIG_PATH).json();
    config = normalizeConfig(raw);
  } catch {
    config = normalizeConfig(null);
  }
}

async function saveFunConfig(): Promise<void> {
  await Bun.write(CONFIG_PATH, JSON.stringify(config, null, 2) + "\n");
}

export function isConfiguredFunChannel(channelId: string): boolean {
  return config.channelId.length > 0 && channelId === config.channelId;
}

export function isFunTrigger(channelId: string, content: string): boolean {
  if (!config.enabled || !isConfiguredFunChannel(channelId)) return false;
  const text = content.trim().toLowerCase();
  return text === "server" || text === "guild";
}

export async function toggleFun(channelId: string): Promise<boolean | null> {
  if (!isConfiguredFunChannel(channelId)) return null;
  config.enabled = !config.enabled;
  await saveFunConfig();
  return config.enabled;
}

export function getFunEnabled(): boolean {
  return config.enabled;
}
