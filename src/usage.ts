import { appendFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { join } from "node:path";
import { recordTopicVote, TOPIC_VOTE_KINDS, type Ledger, type TopicVoteKind } from "./ledger.ts";

export interface UsageEvent {
  ts: string;
  kind: TopicVoteKind;
  topic: string;
  session: string;
}

export interface FoldOptions {
  pid?: number;
  isAlive?: (pid: number) => boolean;
}

export const USAGE_LOG = "usage.jsonl";

const FOLDING_FILE = /^usage\.(\d+)\.folding\.jsonl$/;

export function usageLogPath(stateDir: string): string {
  return join(stateDir, USAGE_LOG);
}

export function appendUsageEvent(stateDir: string, event: UsageEvent): void {
  mkdirSync(stateDir, { recursive: true });
  appendFileSync(usageLogPath(stateDir), `${JSON.stringify(event)}\n`);
}

function isUsageEvent(value: unknown): value is UsageEvent {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.ts === "string" &&
    typeof record.topic === "string" &&
    typeof record.session === "string" &&
    TOPIC_VOTE_KINDS.includes(record.kind as TopicVoteKind)
  );
}

export function parseUsageLog(raw: string): UsageEvent[] {
  const events: UsageEvent[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isUsageEvent(value)) {
        events.push({ ts: value.ts, kind: value.kind, topic: value.topic, session: value.session });
      }
    } catch {
      continue;
    }
  }
  return events;
}

export function readUsageEvents(stateDir: string): UsageEvent[] {
  try {
    return parseUsageLog(readFileSync(usageLogPath(stateDir), "utf8"));
  } catch {
    return [];
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function claimUsageLogs(stateDir: string, options: FoldOptions = {}): string[] {
  const pid = options.pid ?? process.pid;
  const isAlive = options.isAlive ?? processAlive;
  let entries: string[];
  try {
    entries = readdirSync(stateDir);
  } catch {
    return [];
  }
  const claimed = entries
    .map((entry) => ({ entry, match: FOLDING_FILE.exec(entry) }))
    .filter(({ match }) => match !== null && (Number(match[1]) === pid || !isAlive(Number(match[1]))))
    .map(({ entry }) => join(stateDir, entry))
    .sort();
  const own = join(stateDir, `usage.${pid}.folding.jsonl`);
  if (entries.includes(USAGE_LOG)) {
    if (claimed.includes(own)) {
      appendFileSync(own, readFileSync(usageLogPath(stateDir)));
      rmSync(usageLogPath(stateDir), { force: true });
    } else {
      try {
        renameSync(usageLogPath(stateDir), own);
        claimed.push(own);
      } catch {
        return claimed;
      }
    }
  }
  return claimed;
}

export function foldUsageLog(
  stateDir: string,
  apply: (events: UsageEvent[]) => void,
  options: FoldOptions = {},
): UsageEvent[] {
  const files = claimUsageLogs(stateDir, options);
  if (files.length === 0) return [];
  const events = files.flatMap((file) => {
    try {
      return parseUsageLog(readFileSync(file, "utf8"));
    } catch {
      return [];
    }
  });
  apply(events);
  for (const file of files) rmSync(file, { force: true });
  return events;
}

export function foldEventsIntoLedgers(events: UsageEvent[], ledgerFor: (topic: string) => Ledger | null): Set<string> {
  const touched = new Set<string>();
  const ordered = [...events].sort((a, b) => a.ts.localeCompare(b.ts));
  for (const event of ordered) {
    const ledger = ledgerFor(event.topic);
    if (!ledger) continue;
    recordTopicVote(ledger, event.kind, event.ts);
    touched.add(event.topic);
  }
  return touched;
}

export function topicsLoadedInSession(events: UsageEvent[], session: string): string[] {
  return [...new Set(events.filter((event) => event.session === session && event.kind === "loaded").map((event) => event.topic))];
}
