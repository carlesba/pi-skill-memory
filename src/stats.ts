import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { MemoryConfig } from "./config.ts";
import { readHistory, readJsonLines } from "./history.ts";
import { loadLedger } from "./ledger.ts";
import { listTopics, parseTopic } from "./topics.ts";

const KINDS = ["reminded", "loaded", "selected", "injected", "applied", "confirmed", "ignored", "contradicted", "retracted"] as const;
type CountKind = typeof KINDS[number];
interface CountEvent {
  topic: string;
  id?: string;
  kind: CountKind;
  ts: string;
  session?: string;
}

export function parseStatsArgs(args: string[]): string | undefined {
  if (args.length === 0) return undefined;
  const date = args[1];
  if (args.length !== 2 || args[0] !== "--since" || !date || !/^\d{4}-\d{2}-\d{2}$/.test(date) ||
    !Number.isFinite(Date.parse(date)) || new Date(date).toISOString().slice(0, 10) !== date) {
    throw new Error("usage: stats [--since YYYY-MM-DD]");
  }
  return date;
}

function countEvents(records: Record<string, unknown>[]): CountEvent[] {
  return records.filter((record) => typeof record.topic === "string" && typeof record.ts === "string" &&
    KINDS.includes(record.kind as CountKind)) as unknown as CountEvent[];
}

function eventKey(event: CountEvent, includeSession: boolean): string {
  return JSON.stringify([event.topic, event.id ?? "", event.kind, event.ts, includeSession ? event.session : ""]);
}

function supplement(primary: CountEvent[], fallback: CountEvent[], includeSession = false): CountEvent[] {
  const remaining = new Map<string, number>();
  for (const event of primary) remaining.set(eventKey(event, includeSession), (remaining.get(eventKey(event, includeSession)) ?? 0) + 1);
  const extra: CountEvent[] = [];
  for (const event of fallback) {
    const key = eventKey(event, includeSession);
    const count = remaining.get(key) ?? 0;
    if (count > 0) remaining.set(key, count - 1);
    else extra.push(event);
  }
  return extra;
}

function table(rows: string[][]): string {
  const widths = rows[0]!.map((_, column) => Math.max(...rows.map((row) => row[column]!.length)));
  return rows.map((row) => row.map((cell, column) => cell.padEnd(widths[column]!)).join("  ").trimEnd()).join("\n");
}

export function formatStats(config: Pick<MemoryConfig, "dir" | "stateDir">, since?: string): string {
  const inWindow = (ts: unknown): boolean => typeof ts === "string" && Number.isFinite(Date.parse(ts)) && (!since || ts >= since);
  const usage = readHistory(config.stateDir, "usage");
  const votes = readHistory(config.stateDir, "votes");
  const extractions = readHistory(config.stateDir, "extractions").filter((event) => inWindow(event.ts));
  const runs = readJsonLines(join(config.stateDir, "runs.jsonl"))
    .filter((event) => inWindow(event.ts) && (event.kind === undefined || event.kind === "write"));
  let files: string[];
  try {
    files = readdirSync(config.stateDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    files = [];
  }
  const pending = files.filter((file) => file === "usage.jsonl" || /^usage\.\d+\.folding\.jsonl$/.test(file))
    .flatMap((file) => readJsonLines(join(config.stateDir, file)));
  const archivedEvents = countEvents([...usage, ...votes]);
  const pendingEvents = supplement(archivedEvents, countEvents(pending), true);
  const recorded = [...archivedEvents, ...pendingEvents];
  const topics = listTopics(config.dir);
  const exampleCounts = new Map(topics.map((topic) => [topic.name,
    parseTopic(readFileSync(topic.path, "utf8"))?.memories.filter((memory) => memory.kind === "example").length ?? 0]));
  const exampleAdds = readHistory(config.stateDir, "examples").filter((event) => inWindow(event.ts) && event.kind === "added");
  const ledgerEvents: CountEvent[] = [];
  for (const [topic, path] of [...topics.map((topic) => [topic.name, join(dirname(topic.path), "ledger.json")]),
    ["user.md", join(config.dir, "user.ledger.json")]] as [string, string][]) {
    const ledger = loadLedger(path);
    ledgerEvents.push(...ledger.topic.votes.map((vote) => ({ ...vote, topic })));
    for (const [id, memory] of Object.entries(ledger.memories)) {
      ledgerEvents.push(...memory.votes.map((vote) => ({ ...vote, topic, id })));
    }
  }
  const legacy = supplement(recorded, ledgerEvents).filter((event) => inWindow(event.ts));
  const events = [...recorded.filter((event) => inWindow(event.ts)), ...legacy];
  const sessions = new Set([...events, ...extractions, ...runs, ...exampleAdds].flatMap((event) =>
    typeof event.session === "string" && event.session ? [event.session] : []));
  const names = [...new Set([...topics.map((topic) => topic.name), ...events.map((event) => event.topic), ...exampleAdds.flatMap((event) => typeof event.topic === "string" ? [event.topic] : [])])]
    .filter((name) => name !== "user.md").sort();
  const totals = (topic: string): number[] => KINDS.map((kind) => events.filter((event) => event.topic === topic && event.kind === kind).length);
  const rows = [["topic", ...KINDS], ...names.map((name) => [name, ...totals(name).map(String)]),
    ["user.md", ...totals("user.md").map(String)]];
  const outcomes = new Map<string, number>();
  for (const run of runs) {
    const outcome = String(run.outcome);
    outcomes.set(outcome, (outcomes.get(outcome) ?? 0) + 1);
  }
  const reasons = new Map<string, number>();
  let droppedVotes = 0;
  for (const extraction of extractions) {
    if (!Array.isArray(extraction.dropped)) continue;
    for (const item of extraction.dropped) {
      if (!item || typeof item !== "object") continue;
      if (item.type === "vote") { droppedVotes++; continue; }
      if (item.type !== "candidate" || typeof item.reason !== "string") continue;
      const reason = item.reason.replace(/^candidates\[\d+\][. ]?/, "");
      reasons.set(reason, (reasons.get(reason) ?? 0) + 1);
    }
  }
  const selectedPairs = new Map<string, CountEvent>();
  for (const event of events) {
    if (event.kind !== "selected" || !event.session) continue;
    const key = JSON.stringify([event.topic, event.session]);
    const previous = selectedPairs.get(key);
    if (!previous || event.ts < previous.ts) selectedPairs.set(key, event);
  }
  const appliedSelections = [...selectedPairs.values()].filter((selection) => events.some((event) =>
    event.kind === "applied" && event.topic === selection.topic && event.session === selection.session && event.ts >= selection.ts)).length;
  const triggers = ["shutdown", "compaction", "recovery", "manual", "unknown"];
  const triggerOf = (event: Record<string, unknown>) => typeof event.trigger === "string" ? event.trigger : "unknown";
  const triggerRows = triggers.map((trigger) => [trigger,
    String(runs.filter((run) => triggerOf(run) === trigger).length),
    String(extractions.filter((event) => triggerOf(event) === trigger).reduce((sum, event) =>
      sum + (Array.isArray(event.candidates) ? event.candidates.length : 0), 0))]);
  const confirmations = events.filter((event) => event.kind === "confirmed" && event.session);
  const confirmationKeys = new Set(confirmations.map((event) => JSON.stringify([event.session, event.topic, event.id])));
  const exampleRows = names.map((name) => [name, String(exampleCounts.get(name) ?? 0),
    String(exampleAdds.filter((event) => event.topic === name).length)]);
  const episodeDrops = extractions.flatMap((event) => Array.isArray(event.dropped) ? event.dropped : [])
    .filter((item) => item?.type === "episode");
  const exampleGroups = [true, false].map((withExamples) => {
    const members = topics.filter((topic) => ((exampleCounts.get(topic.name) ?? 0) > 0) === withExamples);
    const applied = events.filter((event) => event.kind === "applied" && members.some((topic) => topic.name === event.topic)).length;
    return [withExamples ? "with examples" : "without examples", String(members.length), String(applied), members.length ? (applied / members.length).toFixed(2) : "N/A"];
  });
  const neverLoaded = names.filter((name) => totals(name)[1] === 0);
  return [
    `Memory stats (${since ? `since ${since}, UTC inclusive` : "all time"})`,
    `Sessions in window: ${sessions.size} known (legacy ledgers have no session ids)`,
    `Sources: history + pending usage; ${legacy.length} ledger-only events (capped, incomplete history).`,
    "", table(rows), "", `Topics never loaded in window: ${neverLoaded.length ? neverLoaded.join(", ") : "none"}`,
    `Selected topic/session pairs later applied: ${appliedSelections}/${selectedPairs.size} (same session, at or after selection)`,
    "", "Writer runs by outcome:",
    outcomes.size ? table([["outcome", "runs"], ...[...outcomes].sort().map(([kind, count]) => [kind, String(count)])]) : "none",
    `Pass-1 validation failures: ${runs.filter((run) => typeof run.error === "string" && run.error.startsWith("pass 1 rejected:")).length}`,
    "", "Writer runs and lessons kept by trigger (kept = pass-1 accepted candidates, not applied writes):",
    table([["trigger", "runs", "lessons kept"], ...triggerRows]),
    `Repeated confirmed votes on the same memory/session: ${confirmations.length - confirmationKeys.size}`,
    "", "Candidates dropped by reason:",
    reasons.size ? table([["reason", "count"], ...[...reasons].sort().map(([reason, count]) => [reason, String(count)])]) : "none recorded",
    `Votes dropped: ${droppedVotes}`,
    "", "Examples per topic (current) and added in window (includes consolidation copies):",
    table([["topic", "examples", "added"], ...exampleRows]),
    `Episodes kept: ${extractions.reduce((sum, event) => sum + (Array.isArray(event.episodes) ? event.episodes.length : 0), 0)} (pass-1 accepted, not writes); dropped: ${episodeDrops.length}`,
    ...episodeDrops.map((item) => `Episode dropped: ${String(item.reason)}`),
    "Applied votes by current topic example cohort (not causal; excludes removed topics):",
    table([["cohort", "topics", "applied", "applied/topic"], ...exampleGroups]),
  ].join("\n");
}
