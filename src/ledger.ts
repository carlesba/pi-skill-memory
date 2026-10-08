import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MEMORY_VOTE_KINDS = ["applied", "confirmed", "ignored", "contradicted", "retracted"] as const;
export const TOPIC_VOTE_KINDS = ["loaded", "reminded"] as const;
export const MAX_VOTES = 20;

export type MemoryVoteKind = (typeof MEMORY_VOTE_KINDS)[number];
export type StoredMemoryVoteKind = Exclude<MemoryVoteKind, "retracted">;
export type TopicVoteKind = (typeof TOPIC_VOTE_KINDS)[number];

export interface Vote<K extends string> {
  kind: K;
  ts: string;
}

export interface MemoryEntry {
  source: string;
  learned: string;
  votes: Vote<StoredMemoryVoteKind>[];
}

export interface Ledger {
  nextId: number;
  topic: { created?: string; votes: Vote<TopicVoteKind>[] };
  memories: Record<string, MemoryEntry>;
}

export type VoteOutcome = "recorded" | "retracted" | "unknown";

const MEMORY_ID = /^r(\d+)$/;

export function emptyLedger(created?: string): Ledger {
  return { nextId: 1, topic: created ? { created, votes: [] } : { votes: [] }, memories: {} };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readVotes<K extends string>(value: unknown, kinds: readonly K[]): Vote<K>[] {
  return readVotesUncapped(value, kinds).slice(-MAX_VOTES);
}

function readVotesUncapped<K extends string>(value: unknown, kinds: readonly K[]): Vote<K>[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (vote): vote is Vote<K> =>
        isRecord(vote) && typeof vote.ts === "string" && kinds.includes(vote.kind as K),
    )
    .map((vote) => ({ kind: vote.kind, ts: vote.ts }));
}

function readTopicVotes(value: unknown): Vote<TopicVoteKind>[] {
  const votes: Vote<TopicVoteKind>[] = [];
  for (const vote of readVotesUncapped(value, TOPIC_VOTE_KINDS)) pushTopicVote(votes, vote);
  return votes;
}

export function memoryIdNumber(id: string): number | null {
  const match = MEMORY_ID.exec(id);
  return match ? Number(match[1]) : null;
}

export function parseLedger(raw: string): Ledger {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return emptyLedger();
  }
  if (!isRecord(data)) return emptyLedger();
  const storedKinds = MEMORY_VOTE_KINDS.filter((kind): kind is StoredMemoryVoteKind => kind !== "retracted");
  const memories: Record<string, MemoryEntry> = {};
  let highest = 0;
  if (isRecord(data.memories)) {
    for (const [id, entry] of Object.entries(data.memories)) {
      const number = memoryIdNumber(id);
      if (number === null || !isRecord(entry)) continue;
      highest = Math.max(highest, number);
      memories[id] = {
        source: typeof entry.source === "string" ? entry.source : "",
        learned: typeof entry.learned === "string" ? entry.learned : "",
        votes: readVotes(entry.votes, storedKinds),
      };
    }
  }
  const topicData = isRecord(data.topic) ? data.topic : {};
  const declaredNext = typeof data.nextId === "number" && Number.isInteger(data.nextId) ? data.nextId : 1;
  const topic: Ledger["topic"] = { votes: readTopicVotes(topicData.votes) };
  if (typeof topicData.created === "string") topic.created = topicData.created;
  return { nextId: Math.max(declaredNext, highest + 1, 1), topic, memories };
}

export function loadLedger(path: string): Ledger {
  try {
    return parseLedger(readFileSync(path, "utf8"));
  } catch {
    return emptyLedger();
  }
}

export function saveLedger(path: string, ledger: Ledger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(ledger, null, 2)}\n`);
  renameSync(temporary, path);
}

export function isoDate(now: Date): string {
  return now.toISOString().slice(0, 10);
}

export function mintId(ledger: Ledger, source: string, now: Date): string {
  const id = `r${ledger.nextId}`;
  ledger.nextId += 1;
  ledger.memories[id] = { source, learned: isoDate(now), votes: [] };
  return id;
}

export function reserveIdsAbove(ledger: Ledger, ids: string[]): void {
  for (const id of ids) {
    const number = memoryIdNumber(id);
    if (number !== null && number >= ledger.nextId) ledger.nextId = number + 1;
  }
}

function pushVote<K extends string>(votes: Vote<K>[], vote: Vote<K>): void {
  votes.push(vote);
  if (votes.length > MAX_VOTES) votes.splice(0, votes.length - MAX_VOTES);
}

export function recordVote(ledger: Ledger, id: string, kind: MemoryVoteKind, now: Date): VoteOutcome {
  const entry = ledger.memories[id];
  if (!entry) return "unknown";
  if (kind === "retracted") {
    delete ledger.memories[id];
    return "retracted";
  }
  pushVote(entry.votes, { kind, ts: now.toISOString() });
  return "recorded";
}

function pushTopicVote(votes: Vote<TopicVoteKind>[], vote: Vote<TopicVoteKind>): void {
  votes.push(vote);
  const sameKind = votes.filter((existing) => existing.kind === vote.kind).length;
  if (sameKind <= MAX_VOTES) return;
  votes.splice(votes.findIndex((existing) => existing.kind === vote.kind), 1);
}

export function recordTopicVote(ledger: Ledger, kind: TopicVoteKind, ts: string): void {
  pushTopicVote(ledger.topic.votes, { kind, ts });
}

export function sweepLedger(ledger: Ledger, bodyIds: Iterable<string>): string[] {
  const present = new Set(bodyIds);
  const removed: string[] = [];
  for (const id of Object.keys(ledger.memories)) {
    if (!present.has(id)) {
      delete ledger.memories[id];
      removed.push(id);
    }
  }
  return removed;
}
