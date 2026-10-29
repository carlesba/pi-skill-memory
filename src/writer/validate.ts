import type { DroppedExtractionItem } from "../history.ts";
import { parseFrontmatter } from "../frontmatter.ts";
import { MEMORY_VOTE_KINDS, type MemoryVoteKind } from "../ledger.ts";
import { parseMemories, parseTopicMemories, parseScope, slugify, type Memory, type Scope } from "../topics.ts";
import {
  MAX_CANDIDATES,
  MAX_EPISODES,
  MAX_EPISODE_SITUATION_CHARS,
  MAX_EPISODE_APPROACH_CHARS,
  MAX_EPISODE_OUTCOME_CHARS,
  MAX_EPISODE_EVIDENCE_CHARS,
  MAX_DESCRIPTION_CHARS,
  MAX_EVIDENCE_WORDS,
  MAX_REMOVED_WHY_CHARS,
  MAX_RULE_CHARS,
  MAX_SPLIT_CHARS,
  MAX_WHY_CHARS,
} from "./limits.ts";

export type CandidateTarget =
  | { kind: "user" }
  | { kind: "topic"; name: string }
  | { kind: "new"; slug: string }
  | { kind: "proposal"; skill: string };

export interface Candidate {
  rule: string;
  why: string;
  evidence: string;
  scope: Scope;
  target: CandidateTarget;
}

export interface Episode extends Omit<Candidate, "rule" | "why"> {
  situation: string;
  approach: string;
  outcome: string;
}

export interface MemoryVote {
  topic: string;
  id: string;
  kind: MemoryVoteKind;
}

export interface Removal {
  id: string;
  why: string;
}

export type Validated<T> = ({ ok: true } & T) | { ok: false; error: string };

export interface ExtractContext {
  humanMessages?: string[];
  maxEpisodes?: number;
  topicNames: ReadonlySet<string>;
  skillNames: ReadonlySet<string>;
  memoryIdsOf: (topic: string) => ReadonlySet<string> | null;
}

export interface ExtractResult {
  candidates: Candidate[];
  episodes: Episode[];
  votes: MemoryVote[];
  dropped: string[];
  rejected: DroppedExtractionItem[];
}

export interface MergeResult {
  description: string;
  memories: Memory[];
  removed: Removal[];
  split: string | null;
}

export interface UserMergeResult {
  memories: Memory[];
  removed: Removal[];
}

const HEADING_LINE = /^[ \t]{0,3}(#{1,6}([ \t]|$)|---[ \t]*$)/m;
const ID_MARKER = /\^(r\d+|new)\b/;

class Rejection extends Error {}

function reject(message: string): never {
  throw new Rejection(message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(record: Record<string, unknown>, key: string, max: number, where: string): string {
  const value = record[key];
  if (typeof value !== "string") reject(`${where}.${key} must be a string`);
  const text = value.trim();
  if (text === "") reject(`${where}.${key} is empty`);
  if (text.length > max) reject(`${where}.${key} is longer than ${max} chars`);
  return text;
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => word !== "").length;
}

function parseTarget(raw: string, context: ExtractContext, where: string): CandidateTarget {
  if (raw === "user.md") return { kind: "user" };
  if (raw.startsWith("new:")) {
    const slug = raw.slice("new:".length);
    if (slug === "" || slugify(slug) !== slug) reject(`${where}.target has an invalid topic slug: ${raw}`);
    return { kind: "new", slug };
  }
  if (raw.startsWith("proposal:")) {
    const skill = raw.slice("proposal:".length);
    if (!context.skillNames.has(skill)) reject(`${where}.target names an unknown skill: ${raw}`);
    return { kind: "proposal", skill };
  }
  if (context.topicNames.has(raw)) return { kind: "topic", name: raw };
  return reject(`${where}.target is not user.md, an existing topic, new:<slug> or proposal:<skill>: ${raw}`);
}

function parseCandidate(value: unknown, index: number, context: ExtractContext): Candidate {
  const where = `candidates[${index}]`;
  if (!isRecord(value)) reject(`${where} must be an object`);
  const rule = requiredText(value, "rule", MAX_RULE_CHARS, where);
  const why = requiredText(value, "why", MAX_WHY_CHARS, where);
  const evidence = requiredText(value, "evidence", Number.MAX_SAFE_INTEGER, where);
  if (wordCount(evidence) > MAX_EVIDENCE_WORDS) reject(`${where}.evidence is longer than ${MAX_EVIDENCE_WORDS} words`);
  const scope = typeof value.scope === "string" ? parseScope(value.scope) : null;
  if (!scope) reject(`${where}.scope must be generic or repo:<owner>/<name>`);
  if (typeof value.target !== "string") reject(`${where}.target must be a string`);
  const target = parseTarget(value.target.trim(), context, where);
  return { rule, why, evidence, scope, target };
}

function runValidation<T>(validate: () => T): Validated<T> {
  try {
    return { ok: true, ...validate() };
  } catch (error) {
    if (error instanceof Rejection) return { ok: false, error: error.message };
    throw error;
  }
}

export function validateExtract(value: unknown, context: ExtractContext): Validated<ExtractResult> {
  return runValidation(() => {
    if (!isRecord(value)) reject("pass 1 output must be an object");
    const rawCandidates = value.candidates === undefined ? [] : value.candidates;
    const rawVotes = value.votes === undefined ? [] : value.votes;
    if (!Array.isArray(rawCandidates)) reject("candidates must be an array");
    if (!Array.isArray(rawVotes)) reject("votes must be an array");
    const rawEpisodes = value.episodes === undefined ? [] : value.episodes;
    if (!Array.isArray(rawEpisodes)) reject("episodes must be an array");
    const episodes: Episode[] = [];
    const candidates: Candidate[] = [];
    const votes: MemoryVote[] = [];
    const dropped: string[] = [];
    const rejected: DroppedExtractionItem[] = [];
    rawCandidates.forEach((candidate, index) => {
      try {
        if (index >= MAX_CANDIDATES) reject(`candidates[${index}] exceeds the ${MAX_CANDIDATES} candidate limit`);
        candidates.push(parseCandidate(candidate, index, context));
      } catch (error) {
        if (!(error instanceof Rejection)) throw error;
        rejected.push({ type: "candidate", index, reason: error.message, value: candidate });
      }
    });
    rawEpisodes.forEach((episode, index) => {
      const where = `episodes[${index}]`;
      try {
        if (index >= (context.maxEpisodes ?? MAX_EPISODES)) reject(`${where} exceeds the episode limit`);
        if (!isRecord(episode)) reject(`${where} must be an object`);
        const situation = requiredText(episode, "situation", MAX_EPISODE_SITUATION_CHARS, where);
        const approach = requiredText(episode, "approach", MAX_EPISODE_APPROACH_CHARS, where);
        const outcome = requiredText(episode, "outcome", MAX_EPISODE_OUTCOME_CHARS, where);
        const evidence = requiredText(episode, "evidence", MAX_EPISODE_EVIDENCE_CHARS, where);
        if (wordCount(evidence) > MAX_EVIDENCE_WORDS) reject(`${where}.evidence is longer than ${MAX_EVIDENCE_WORDS} words`);
        if (!context.humanMessages?.some((message) => message.includes(evidence))) reject(`${where}.evidence is not a quote from a User message`);
        const acceptingMessage = context.humanMessages?.flatMap((message) => message.split(/(?<=[.!?])\s+/)).some((message) => message.includes(evidence) &&
          !/\?|\b(not|never|don't|doesn't|didn't|isn't|hasn't|haven't|won't|if|unless|would|could|should)\b/i.test(message));
        if (!acceptingMessage) reject(`${where}.evidence is negated, conditional or questioning in its User sentence`);
        if (!/\b(works|worked|lgtm|approved|merged|landed|adopted|looks good|that’s right|that's right|yes|perfect)\b/i.test(evidence) || /\b(not|never|don't|doesn't|didn't|isn't|hasn't|haven't|won't)\b/i.test(evidence)) reject(`${where}.evidence must show explicit acceptance`);
        const scope = typeof episode.scope === "string" ? parseScope(episode.scope) : null;
        if (!scope) reject(`${where}.scope must be generic or repo:<owner>/<name>`);
        const target = parseTarget(requiredText(episode, "target", 200, where), context, where);
        if (target.kind !== "topic" && target.kind !== "new") reject(`${where}.target must be an existing or new topic`);
        episodes.push({ situation, approach, outcome, evidence, scope, target });
      } catch (error) {
        if (!(error instanceof Rejection)) throw error;
        rejected.push({ type: "episode", index, reason: error.message, value: episode });
      }
    });
    rawVotes.forEach((vote, index) => {
      const where = `votes[${index}]`;
      try {
        if (!isRecord(vote)) reject(`${where} must be an object`);
        if (typeof vote.id !== "string" || typeof vote.topic !== "string") reject(`${where} needs a topic and an id`);
        if (!MEMORY_VOTE_KINDS.includes(vote.kind as MemoryVoteKind)) reject(`${where}.kind is not a vote kind`);
        const ids = context.memoryIdsOf(vote.topic);
        if (!ids || !ids.has(vote.id)) {
          dropped.push(`${vote.topic}#${vote.id}`);
          reject(`${where} names an unknown memory: ${vote.topic}#${vote.id}`);
        }
        votes.push({ topic: vote.topic, id: vote.id, kind: vote.kind as MemoryVoteKind });
      } catch (error) {
        if (!(error instanceof Rejection)) throw error;
        rejected.push({ type: "vote", index, reason: error.message, value: vote });
      }
    });
    return { candidates, episodes, votes, dropped, rejected };
  });
}

function parseRemoved(value: unknown): Removal[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) reject("removed must be an array");
  return value.map((entry, index) => {
    const where = `removed[${index}]`;
    if (!isRecord(entry)) reject(`${where} must be an object`);
    return {
      id: requiredText(entry, "id", 200, where),
      why: requiredText(entry, "why", MAX_REMOVED_WHY_CHARS, where),
    };
  });
}

function checkBodyShape(body: string, maxChars: number): void {
  if (body.length > maxChars) reject(`body is longer than ${maxChars} chars`);
  if (HEADING_LINE.test(body)) reject("body must not contain headings or rules");
}

export interface MarkedBodyContext {
  knownIds: ReadonlySet<string>;
  existingIds: readonly string[];
}

export interface MergeContext extends MarkedBodyContext {
  maxCharsPerTopic: number;
  exampleIds?: ReadonlySet<string>;
  newExamples?: number;
}

function parseMarkedBody(body: string, rawRemoved: unknown, context: MarkedBodyContext, topic = false): { memories: Memory[]; removed: Removal[] } {
  const memories = topic ? parseTopicMemories(body) : parseMemories(body);
  const seen = new Set<string>();
  for (const memory of memories) {
    if (memory.id === null) reject(`a paragraph does not end in ^r<N> or ^new: ${memory.text.slice(0, 60)}`);
    if (memory.text === "") reject(`memory ^${memory.id} has no text`);
    if (ID_MARKER.test(memory.text)) reject(`memory ^${memory.id} holds another id marker`);
    if (memory.id === "new") continue;
    if (!context.knownIds.has(memory.id)) reject(`unknown memory id ^${memory.id}`);
    if (seen.has(memory.id)) reject(`memory id ^${memory.id} appears twice`);
    seen.add(memory.id);
  }
  const removed = parseRemoved(rawRemoved);
  const accounted = new Set(removed.map((entry) => entry.id));
  const unaccounted = context.existingIds.filter((id) => !seen.has(id) && !accounted.has(id));
  if (unaccounted.length > 0) {
    reject(`memories dropped without a removed entry: ${unaccounted.map((id) => `^${id}`).join(", ")}`);
  }
  return { memories, removed };
}

function requiredBody(value: Record<string, unknown>): string {
  if (typeof value.body !== "string") reject("body must be a string");
  return value.body.trim();
}

export function validateMerge(value: unknown, context: MergeContext): Validated<MergeResult> {
  return runValidation(() => {
    if (!isRecord(value)) reject("pass 2 output must be an object");
    const description = requiredText(value, "description", MAX_DESCRIPTION_CHARS, "output").replace(/\s+/g, " ");
    const body = requiredBody(value);
    if (body.length > context.maxCharsPerTopic) reject(`body is longer than ${context.maxCharsPerTopic} chars`);
    checkBodyShape(body.replace(/^## Examples[ \t]*$/m, ""), context.maxCharsPerTopic);
    if ((body.match(/^## Examples[ \t]*$/gm) ?? []).length > 1) reject("duplicate Examples section");
    const split = value.split;
    if (split !== undefined && split !== null && typeof split !== "string") reject("split must be a string or null");
    const splitText = typeof split === "string" && split.trim() !== "" ? split.trim() : null;
    if (splitText !== null && splitText.length > MAX_SPLIT_CHARS) reject(`split is longer than ${MAX_SPLIT_CHARS} chars`);
    const { memories, removed } = parseMarkedBody(body, value.removed, context, true);
    for (const memory of memories) {
      if (memory.id !== "new" && context.exampleIds && (memory.kind === "example") !== context.exampleIds.has(memory.id!)) reject("existing memory changed example kind");
    }
    if (memories.filter((memory) => memory.kind === "example" && memory.id === "new").length > (context.newExamples ?? 0)) reject("new examples lack accepted episodes");
    return { description, memories, removed, split: splitText };
  });
}

export function validateUserMerge(value: unknown, context: MarkedBodyContext): Validated<UserMergeResult> {
  return runValidation(() => {
    if (!isRecord(value)) reject("user.md output must be an object");
    const body = requiredBody(value);
    checkBodyShape(body, Number.MAX_SAFE_INTEGER);
    return parseMarkedBody(body, value.removed, context);
  });
}

export interface ApplyContext {
  name: string;
  original: string;
  addedChars: number;
}

export interface ApplyResult {
  body: string;
  summary: string;
}

export const APPLY_GROWTH_SLACK_CHARS = 1500;
export const APPLY_MIN_KEPT_RATIO = 0.6;

export function maxAppliedChars(original: string, addedChars: number): number {
  return original.length + 2 * addedChars + APPLY_GROWTH_SLACK_CHARS;
}

export function validateApply(data: unknown, context: ApplyContext): Validated<ApplyResult> {
  if (typeof data !== "object" || data === null || Array.isArray(data)) return { ok: false, error: "answer is not a JSON object" };
  const record = data as Record<string, unknown>;
  if (typeof record.body !== "string" || record.body.trim() === "") return { ok: false, error: "body is missing or empty" };
  const body = `${record.body.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n`;
  const summary = typeof record.summary === "string" ? record.summary.trim() : "";
  const parsed = parseFrontmatter(body);
  if (!parsed) return { ok: false, error: "frontmatter does not parse" };
  if ((parsed.fields.name ?? "").trim() !== context.name) {
    return { ok: false, error: `frontmatter name changed from ${context.name} to ${parsed.fields.name ?? "(none)"}` };
  }
  if (parsed.body.trim() === "") return { ok: false, error: "skill body is empty" };
  const limit = maxAppliedChars(context.original, context.addedChars);
  if (body.length > limit) return { ok: false, error: `body grew to ${body.length} chars, more than ${limit}` };
  if (body.length < context.original.length * APPLY_MIN_KEPT_RATIO) {
    return { ok: false, error: `body shrank to ${body.length} chars from ${context.original.length}` };
  }
  if (body === `${context.original.replace(/\r\n/g, "\n").replace(/\s+$/, "")}\n`) return { ok: false, error: "body is unchanged" };
  return { ok: true, body, summary };
}
