// Per-user cooldown for run/compile, persisted to a local JSON file
// so it survives restarts. Format: { "<userid>": <last invoked, ms epoch> }

import { renameSync } from "node:fs";
import { join } from "node:path";
import { logError } from "./log";

export const COOLDOWN_MS = Number(process.env.COOLDOWN_MS ?? 60_000);
const DATA_DIR = process.env.DATA_DIR ?? "data";
const FILE = join(DATA_DIR, "cooldowns.json");

type Store = Record<string, number>;

let store: Store = {};

export async function loadCooldowns(): Promise<void> {
  const file = Bun.file(FILE);
  if (!(await file.exists())) return;
  try {
    const parsed = JSON.parse(await file.text()) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return;
    // keep only sane entries
    const loaded: Store = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "number" && Number.isFinite(v)) loaded[k] = v;
    }
    store = loaded;
  } catch (e) {
    logError("cooldown: could not read", e, FILE);
    store = {};
  }
}

async function save(now: number): Promise<void> {
  try {
    // drop expired entries so the file doesn't grow forever
    for (const [k, v] of Object.entries(store)) {
      if (now - v >= COOLDOWN_MS) delete store[k];
    }
    const tmp = `${FILE}.tmp`;
    await Bun.write(tmp, JSON.stringify(store, null, 2));
    renameSync(tmp, FILE);
  } catch (e) {
    logError("cooldown: could not save", e, FILE);
  }
}

export interface CooldownResult {
  ok: boolean;
  /** ms until the user may run again (0 when ok) */
  retryAfterMs: number;
}

/** ms until this user may run again, 0 if they may now. Does not record. */
export function cooldownWaitMs(userId: string, now = Date.now()): number {
  const last = store[userId];
  return last !== undefined && now - last < COOLDOWN_MS
    ? COOLDOWN_MS - (now - last)
    : 0;
}

// Check the cooldown and, if allowed, record this invocation.
export async function checkCooldown(
  userId: string,
  now = Date.now(),
): Promise<CooldownResult> {
  const last = store[userId];
  if (last !== undefined && now - last < COOLDOWN_MS) {
    return { ok: false, retryAfterMs: COOLDOWN_MS - (now - last) };
  }
  store[userId] = now;
  await save(now);
  return { ok: true, retryAfterMs: 0 };
}
