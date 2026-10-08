import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export type RunOutcomeKind = "ok" | "skipped" | "failed" | "nothing";

export interface RunRecord {
  ts: string;
  session: string;
  outcome: RunOutcomeKind;
  topics: string[];
  error?: string;
  rejected?: string[];
}

export const RUNS_LOG = "runs.jsonl";
export const WRITER_LOG = "writer.log";

export function runsLogPath(stateDir: string): string {
  return join(stateDir, RUNS_LOG);
}

export function writerLogPath(stateDir: string): string {
  return join(stateDir, WRITER_LOG);
}

export function appendRun(stateDir: string, record: RunRecord): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(runsLogPath(stateDir), `${JSON.stringify(record)}\n`);
}

export function readLastRun(stateDir: string): RunRecord | null {
  let raw: string;
  try {
    raw = readFileSync(runsLogPath(stateDir), "utf8");
  } catch {
    return null;
  }
  const lines = raw.split("\n").filter((line) => line.trim() !== "");
  for (let index = lines.length - 1; index >= 0; index--) {
    try {
      const value = JSON.parse(lines[index]!) as RunRecord;
      if (typeof value.outcome === "string" && typeof value.ts === "string") return value;
    } catch {
      continue;
    }
  }
  return null;
}

export function appendWriterLog(stateDir: string, line: string, now: Date = new Date()): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(writerLogPath(stateDir), `${now.toISOString()} ${line}\n`);
}
