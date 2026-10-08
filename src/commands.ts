import type { MemoryConfig } from "./config.ts";
import type { TopicSummary } from "./topics.ts";
import type { RunRecord } from "./writer/runs.ts";

export interface ListedTopic {
  name: string;
  reason: string;
}

export interface ReminderRecord {
  repo: string;
  topics: string[];
  trigger: string;
}

export interface StatusInput {
  config: MemoryConfig;
  topics: TopicSummary[];
  userMemoryChars: number;
  lastRun: RunRecord | null;
  pueuePath: string | null;
}

export function topicCountsByScope(topics: TopicSummary[]): [string, number][] {
  const counts = new Map<string, number>();
  for (const topic of topics) counts.set(topic.scope, (counts.get(topic.scope) ?? 0) + 1);
  return [...counts.entries()].sort(([a], [b]) => (a === "generic" ? -1 : b === "generic" ? 1 : a.localeCompare(b)));
}

function describeRun(run: RunRecord | null): string {
  if (!run) return "last writer run: none recorded";
  const topics = run.topics.length > 0 ? `, topics ${run.topics.join(", ")}` : "";
  const error = run.error ? `, error: ${run.error}` : "";
  const rejected = run.rejected && run.rejected.length > 0 ? `, rejected ${run.rejected.join(", ")}` : "";
  return `last writer run: ${run.outcome} at ${run.ts} for session ${run.session || "(unknown)"}${topics}${rejected}${error}`;
}

function describeRunner(config: MemoryConfig, pueuePath: string | null): string {
  const pueue = pueuePath ? `pueue on PATH at ${pueuePath}` : "pueue not on PATH";
  if (config.runner === "pueue") {
    const effect = pueuePath ? `group ${config.pueueGroup}` : "writers fall back to detached";
    return `runner: pueue (${effect}; ${pueue})`;
  }
  return `runner: detached (${pueue})`;
}

export function formatStatus(input: StatusInput): string {
  const counts = topicCountsByScope(input.topics);
  const lines = [
    `memory dir: ${input.config.dir}`,
    `state dir: ${input.config.stateDir}`,
    input.userMemoryChars > 0 ? `user.md: ${input.userMemoryChars} chars` : "user.md: missing or empty",
    `topics: ${input.topics.length}`,
    ...counts.map(([scope, count]) => `  ${scope}: ${count}`),
    describeRun(input.lastRun),
    describeRunner(input.config, input.pueuePath),
  ];
  return lines.join("\n");
}

export function formatExplain(listed: ListedTopic[], reminders: ReminderRecord[]): string {
  const lines: string[] = [];
  if (listed.length === 0) {
    lines.push("Listed this session: none (no generic topics and no topics for the repo containing cwd).");
  } else {
    lines.push("Listed this session:");
    for (const topic of listed) lines.push(`  ${topic.name}: ${topic.reason}`);
  }
  if (reminders.length === 0) {
    lines.push("Reminded this session: none.");
  } else {
    lines.push("Reminded this session:");
    for (const reminder of reminders) lines.push(`  ${reminder.repo} (${reminder.topics.join(", ")}): ${reminder.trigger}`);
  }
  return lines.join("\n");
}
