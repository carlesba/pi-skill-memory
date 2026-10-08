import {
  closeSync,
  ftruncateSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

export const LOCK_FILE = ".writer.lock";
export const LOCK_POLL_MS = 500;
export const LOCK_TIMEOUT_MS = 30 * 60_000;
export const LOCK_STALE_MS = 5 * 60_000;
export const LOCK_HEARTBEAT_MS = 60_000;
const UNREADABLE_GRACE_MS = 5_000;

export interface LockOptions {
  pollMs?: number;
  timeoutMs?: number;
  staleMs?: number;
  heartbeatMs?: number;
  schedule?: (refresh: () => void, ms: number) => () => void;
  pid?: number;
  now?: () => number;
  isAlive?: (pid: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
}

export class LockTimeoutError extends Error {}

interface LockContent {
  pid: number;
  ts: string;
  token: string;
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function lockPath(dir: string): string {
  return join(dir, LOCK_FILE);
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function parseLock(raw: string): LockContent | null {
  try {
    const value = JSON.parse(raw) as Partial<LockContent>;
    if (typeof value.pid !== "number" || typeof value.ts !== "string") return null;
    return { pid: value.pid, ts: value.ts, token: typeof value.token === "string" ? value.token : "" };
  } catch {
    return null;
  }
}

function isStale(path: string, raw: string, now: number, staleMs: number, isAlive: (pid: number) => boolean): boolean {
  const lock = parseLock(raw);
  if (!lock) {
    try {
      return now - statSync(path).mtimeMs > UNREADABLE_GRACE_MS;
    } catch {
      return false;
    }
  }
  const refreshed = Date.parse(lock.ts);
  return !isAlive(lock.pid) || Number.isNaN(refreshed) || now - refreshed > staleMs;
}

function reclaim(path: string, judged: string, token: string): void {
  const aside = `${path}.${token}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return;
  }
  if (readText(aside) !== judged) {
    try {
      linkSync(aside, path);
    } catch {
      rmSync(aside, { force: true });
      return;
    }
  }
  rmSync(aside, { force: true });
}

function scheduleInterval(refresh: () => void, ms: number): () => void {
  const timer = setInterval(refresh, ms);
  timer.unref();
  return () => clearInterval(timer);
}

function refreshLock(path: string, content: LockContent): void {
  const current = readText(path);
  if (current === null || parseLock(current)?.token !== content.token) return;
  let fd: number;
  try {
    fd = openSync(path, "r+");
  } catch {
    return;
  }
  try {
    const bytes = writeSync(fd, JSON.stringify(content), 0);
    ftruncateSync(fd, bytes);
  } catch {
    return;
  } finally {
    closeSync(fd);
  }
}

export async function acquireLock(dir: string, options: LockOptions = {}): Promise<() => void> {
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const heartbeatMs = options.heartbeatMs ?? LOCK_HEARTBEAT_MS;
  const schedule = options.schedule ?? scheduleInterval;
  const pid = options.pid ?? process.pid;
  const now = options.now ?? Date.now;
  const isAlive = options.isAlive ?? processAlive;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const path = lockPath(dir);
  const token = randomUUID();
  const deadline = now() + timeoutMs;
  mkdirSync(dir, { recursive: true });
  for (;;) {
    try {
      writeFileSync(path, JSON.stringify({ pid, ts: new Date(now()).toISOString(), token }), { flag: "wx" });
      const stopHeartbeat = schedule(
        () => refreshLock(path, { pid, ts: new Date(now()).toISOString(), token }),
        heartbeatMs,
      );
      return () => {
        stopHeartbeat();
        const current = readText(path);
        if (current !== null && parseLock(current)?.token === token) rmSync(path, { force: true });
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const existing = readText(path);
    if (existing !== null && isStale(path, existing, now(), staleMs, isAlive)) {
      reclaim(path, existing, token);
      continue;
    }
    if (now() >= deadline) throw new LockTimeoutError(`timed out waiting for ${path}`);
    await sleep(pollMs);
  }
}

export async function withLock<T>(dir: string, run: () => Promise<T>, options: LockOptions = {}): Promise<T> {
  const release = await acquireLock(dir, options);
  try {
    return await run();
  } finally {
    release();
  }
}
