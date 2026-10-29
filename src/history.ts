import type { WriterTrigger } from "./writer/job.ts";
import { appendFileSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { Candidate, Episode, MemoryVote } from "./writer/validate.ts";

export type HistoryKind = "usage" | "votes" | "extractions" | "examples";

export interface DroppedExtractionItem {
  type: "candidate" | "vote" | "episode";
  index: number;
  reason: string;
  value: unknown;
}

export interface ExtractionEvent {
  trigger?: WriterTrigger;
  endEntryId?: string;
  session: string;
  ts: string;
  model: string;
  candidates: Candidate[];
  episodes?: Episode[];
  dropped: DroppedExtractionItem[];
  votes: MemoryVote[];
  error?: string;
}

export function readJsonLines(path: string): Record<string, unknown>[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return raw.split("\n").flatMap((line) => {
    try {
      const value: unknown = JSON.parse(line);
      return value && typeof value === "object" && !Array.isArray(value) ? [value as Record<string, unknown>] : [];
    } catch {
      return [];
    }
  });
}

export function readHistory(stateDir: string, kind: HistoryKind): Record<string, unknown>[] {
  const dir = join(stateDir, "history");
  let files: string[];
  try {
    files = readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return files.filter((file) => file.startsWith(`${kind}-`) && file.endsWith(".jsonl")).sort()
    .flatMap((file) => readJsonLines(join(dir, file)));
}

export function appendHistory<T extends { ts: string }>(stateDir: string, kind: HistoryKind, event: T): void {
  const dir = join(stateDir, "history");
  mkdirSync(dir, { recursive: true });
  const month = /^\d{4}-\d{2}/.exec(event.ts)?.[0] ?? "undated";
  appendFileSync(join(dir, `${kind}-${month}.jsonl`), `${JSON.stringify(event)}\n`);
}
