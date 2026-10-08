import type { Ledger, MemoryEntry, StoredMemoryVoteKind, TopicVoteKind, Vote } from "./ledger.ts";
import { memoryIdNumber } from "./ledger.ts";
import type { Scope } from "./topics.ts";

export const VOTE_VALUES: Record<StoredMemoryVoteKind | TopicVoteKind, number> = {
  applied: 1,
  confirmed: 1,
  ignored: 1,
  contradicted: -2,
  loaded: 1,
  reminded: 0,
};

export const MAX_STALE_TOPICS_PER_RUN = 3;

const DAY_MS = 86_400_000;

export interface WeightSettings {
  halfLifeDays: number;
  protectNewDays: number;
  staleTopicDays: number;
}

export interface TopicCaps {
  maxGenericTopics: number;
  maxTopicsPerRepo: number;
}

export interface WeightedTopic {
  name: string;
  scope: Scope;
  ledger: Ledger;
}

export interface SimilarityTopic {
  name: string;
  description: string;
  weight: number;
}

export function ageDays(timestamp: string, now: Date): number | null {
  const time = Date.parse(timestamp);
  if (Number.isNaN(time)) return null;
  return Math.max(0, (now.getTime() - time) / DAY_MS);
}

export function decayedWeight(votes: Vote<StoredMemoryVoteKind | TopicVoteKind>[], now: Date, halfLifeDays: number): number {
  let total = 0;
  for (const vote of votes) {
    const age = ageDays(vote.ts, now);
    if (age === null) continue;
    const factor = halfLifeDays > 0 ? 0.5 ** (age / halfLifeDays) : age === 0 ? 1 : 0;
    total += VOTE_VALUES[vote.kind] * factor;
  }
  return total;
}

export function memoryWeight(entry: MemoryEntry | undefined, now: Date, halfLifeDays: number): number {
  return entry ? decayedWeight(entry.votes, now, halfLifeDays) : 0;
}

export function topicWeight(ledger: Ledger, now: Date, halfLifeDays: number): number {
  const loaded = decayedWeight(ledger.topic.votes.filter((vote) => vote.kind === "loaded"), now, halfLifeDays);
  let memories = 0;
  for (const entry of Object.values(ledger.memories)) memories += memoryWeight(entry, now, halfLifeDays);
  return loaded + memories;
}

export function isProtected(created: string | null | undefined, now: Date, protectNewDays: number): boolean {
  if (!created) return false;
  const age = ageDays(created, now);
  return age !== null && age < protectNewDays;
}

function compareLearned(a: string, b: string): number {
  const left = Date.parse(a);
  const right = Date.parse(b);
  const leftTime = Number.isNaN(left) ? -Infinity : left;
  const rightTime = Number.isNaN(right) ? -Infinity : right;
  return leftTime - rightTime;
}

export function selectMemoryEvictions(
  ledger: Ledger,
  ids: string[],
  maxMemories: number,
  now: Date,
  settings: Pick<WeightSettings, "halfLifeDays" | "protectNewDays">,
): string[] {
  const excess = ids.length - maxMemories;
  if (excess <= 0) return [];
  return ids
    .filter((id) => !isProtected(ledger.memories[id]?.learned, now, settings.protectNewDays))
    .map((id) => ({
      id,
      weight: memoryWeight(ledger.memories[id], now, settings.halfLifeDays),
      learned: ledger.memories[id]?.learned ?? "",
      number: memoryIdNumber(id) ?? 0,
    }))
    .sort((a, b) => a.weight - b.weight || compareLearned(a.learned, b.learned) || a.number - b.number)
    .slice(0, excess)
    .map((candidate) => candidate.id);
}

export function topicCreated(ledger: Ledger): string | null {
  if (ledger.topic.created) return ledger.topic.created;
  const dates = [
    ...Object.values(ledger.memories).map((entry) => entry.learned),
    ...ledger.topic.votes.map((vote) => vote.ts),
  ].filter((value) => !Number.isNaN(Date.parse(value)));
  if (dates.length === 0) return null;
  return dates.sort(compareLearned)[0]!;
}

export function scopeCap(scope: Scope, caps: TopicCaps): number {
  return scope === "generic" ? caps.maxGenericTopics : caps.maxTopicsPerRepo;
}

export function isScopeAtCap(topics: { scope: Scope }[], scope: Scope, caps: TopicCaps): boolean {
  return topics.filter((topic) => topic.scope === scope).length >= scopeCap(scope, caps);
}

export function selectTopicEvictions(
  topics: WeightedTopic[],
  caps: TopicCaps,
  now: Date,
  settings: Pick<WeightSettings, "halfLifeDays" | "protectNewDays">,
): string[] {
  const byScope = new Map<Scope, WeightedTopic[]>();
  for (const topic of topics) byScope.set(topic.scope, [...(byScope.get(topic.scope) ?? []), topic]);
  const evicted: string[] = [];
  for (const [scope, group] of byScope) {
    const excess = group.length - scopeCap(scope, caps);
    if (excess <= 0) continue;
    const chosen = group
      .filter((topic) => !isProtected(topicCreated(topic.ledger), now, settings.protectNewDays))
      .map((topic) => ({ name: topic.name, weight: topicWeight(topic.ledger, now, settings.halfLifeDays) }))
      .sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name))
      .slice(0, excess);
    evicted.push(...chosen.map((topic) => topic.name));
  }
  return evicted;
}

export function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared++;
  return shared / (left.size + right.size - shared);
}

export function closestTopic(
  text: string,
  topics: SimilarityTopic[],
): { name: string; similarity: number } | null {
  const tokens = tokenize(text);
  let best: { name: string; similarity: number; weight: number } | null = null;
  for (const topic of topics) {
    const similarity = jaccard(tokens, tokenize(`${topic.name.replace(/^mem-/, "")} ${topic.description}`));
    const better =
      best === null ||
      similarity > best.similarity ||
      (similarity === best.similarity && topic.weight > best.weight);
    if (better) best = { name: topic.name, similarity, weight: topic.weight };
  }
  return best ? { name: best.name, similarity: best.similarity } : null;
}

export function isStaleTopic(ledger: Ledger, now: Date, staleTopicDays: number): boolean {
  const created = topicCreated(ledger);
  if (!created) return false;
  const createdAge = ageDays(created, now);
  if (createdAge === null || createdAge <= staleTopicDays) return false;
  return !ledger.topic.votes.some((vote) => {
    if (vote.kind !== "loaded") return false;
    const age = ageDays(vote.ts, now);
    return age !== null && age <= staleTopicDays;
  });
}

export function selectStaleTopics(
  topics: WeightedTopic[],
  now: Date,
  settings: Pick<WeightSettings, "halfLifeDays" | "staleTopicDays">,
  limit: number = MAX_STALE_TOPICS_PER_RUN,
): string[] {
  return topics
    .filter((topic) => isStaleTopic(topic.ledger, now, settings.staleTopicDays))
    .map((topic) => ({ name: topic.name, weight: topicWeight(topic.ledger, now, settings.halfLifeDays) }))
    .sort((a, b) => a.weight - b.weight || a.name.localeCompare(b.name))
    .slice(0, limit)
    .map((topic) => topic.name);
}
