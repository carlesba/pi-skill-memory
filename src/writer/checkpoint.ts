import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { MemoryConfig } from "../config.ts";
import { readJsonLines } from "../history.ts";
import { activeBranch, parseSession, type RawEntry } from "./session.ts";

export const WATERMARK_TYPE = "pi-skill-memory-watermark";

export function processedEntryIds(stateDir: string, sessionId: string): string[] {
  return readJsonLines(join(stateDir, "runs.jsonl")).flatMap((run) =>
    run.kind !== "apply" && run.session === sessionId && (run.outcome === "ok" || run.outcome === "nothing") &&
    typeof run.endEntryId === "string" ? [run.endEntryId] : []);
}

export function unprocessedEntries<T extends { id?: unknown }>(branch: readonly T[], processed: readonly string[]): T[] {
  const ids = new Set(processed);
  const start = branch.reduce((last, entry, index) => ids.has(String(entry.id)) ? index + 1 : last, 0);
  return branch.slice(start);
}

export interface RecoverableSession {
  sessionFile: string;
  sessionId: string;
  cwd: string;
  endEntryId: string;
}

export async function recoverableSessions(config: MemoryConfig, currentSession: string, now: Date): Promise<RecoverableSession[]> {
  if (config.recoverDays === 0 || config.recoverMaxSessions < 1) return [];
  const readRecords = async (path: string): Promise<Record<string, unknown>[]> => {
    try {
      return (await readFile(path, "utf8")).split("\n").flatMap((line) => {
        try { const value = JSON.parse(line); return value && typeof value === "object" ? [value] : []; } catch { return []; }
      });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const recorded = new Set((await readRecords(join(config.stateDir, "runs.jsonl")))
    .filter((run) => run.kind !== "apply").map((run) => run.session));
  const root = join(config.agentDir, "sessions");
  const list = async (dir: string) => {
    try { return await readdir(dir, { withFileTypes: true }); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
  };
  const queued = new Set<string>();
  for (const file of await list(join(config.stateDir, "jobs"))) {
    if (!file.isFile() || !file.name.endsWith(".json")) continue;
    try {
      const job = JSON.parse(await readFile(join(config.stateDir, "jobs", file.name), "utf8"));
      if (job.kind !== "apply" && typeof job.sessionId === "string") queued.add(job.sessionId);
    } catch { continue; }
  }
  const paths: string[] = [];
  for (const entry of await list(root)) {
    if (entry.name.startsWith("run-")) continue;
    if (entry.isFile() && entry.name.endsWith(".jsonl")) paths.push(join(root, entry.name));
    if (!entry.isDirectory()) continue;
    for (const file of await list(join(root, entry.name))) {
      if (file.isFile() && file.name.endsWith(".jsonl")) paths.push(join(root, entry.name, file.name));
    }
  }
  const recent = (await Promise.all(paths.map(async (path) => ({ path, modified: (await stat(path)).mtimeMs }))))
    .filter((file) => file.modified >= now.getTime() - config.recoverDays * 86_400_000)
    .sort((a, b) => b.modified - a.modified);
  const found: RecoverableSession[] = [];
  for (const { path } of recent) {
    const entries = await readRecords(path);
    const header = entries.find((entry) => entry.type === "session");
    if (typeof header?.id !== "string" || header.id === currentSession || recorded.has(header.id) || queued.has(header.id)) continue;
    const end = activeBranch(entries as RawEntry[]).at(-1)?.id;
    if (typeof end !== "string") continue;
    const digest = parseSession(entries.map((entry) => JSON.stringify(entry)).join("\n"), {
      dir: config.dir, learnFromSources: config.learnFromSources,
      resolver: { resolvePath: () => null, resolveDirectory: () => null },
    });
    const humans = digest.turns.filter((turn) => turn.human).length;
    if (humans === 0 || humans < config.minUserMessages) continue;
    found.push({ sessionFile: path, sessionId: header.id, cwd: digest.cwd, endEntryId: end });
    if (found.length >= Math.floor(config.recoverMaxSessions)) break;
  }
  return found;
}
