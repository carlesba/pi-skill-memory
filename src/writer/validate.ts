import { MEMORY_VOTE_KINDS, type MemoryVoteKind } from "../ledger.ts";
import { parseMemories, parseScope, slugify, type Memory, type Scope } from "../topics.ts";
import {
  MAX_CANDIDATES,
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
  topicNames: ReadonlySet<string>;
  skillNames: ReadonlySet<string>;
  memoryIdsOf: (topic: string) => ReadonlySet<string> | null;
}

export interface ExtractResult {
  candidates: Candidate[];
  votes: MemoryVote[];
  dropped: string[];
}

export interface MergeResult {
  description: string;
  memories: Memory[];
  removed: Removal[];
  split: string | null;
}

export interface UserMergeResult {
  body: string;
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
    const rawCandidates = value.candidates ?? [];
    const rawVotes = value.votes ?? [];
    if (!Array.isArray(rawCandidates)) reject("candidates must be an array");
    if (!Array.isArray(rawVotes)) reject("votes must be an array");
    if (rawCandidates.length > MAX_CANDIDATES) reject(`more than ${MAX_CANDIDATES} candidates`);
    const candidates = rawCandidates.map((candidate, index) => parseCandidate(candidate, index, context));
    const votes: MemoryVote[] = [];
    const dropped: string[] = [];
    rawVotes.forEach((vote, index) => {
      const where = `votes[${index}]`;
      if (!isRecord(vote)) reject(`${where} must be an object`);
      if (typeof vote.id !== "string" || typeof vote.topic !== "string") reject(`${where} needs a topic and an id`);
      if (!MEMORY_VOTE_KINDS.includes(vote.kind as MemoryVoteKind)) reject(`${where}.kind is not a vote kind`);
      const ids = context.memoryIdsOf(vote.topic);
      if (!ids || !ids.has(vote.id)) {
        dropped.push(`${vote.topic}#${vote.id}`);
        return;
      }
      votes.push({ topic: vote.topic, id: vote.id, kind: vote.kind as MemoryVoteKind });
    });
    return { candidates, votes, dropped };
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

export interface MergeContext {
  knownIds: ReadonlySet<string>;
  maxCharsPerTopic: number;
}

export function validateMerge(value: unknown, context: MergeContext): Validated<MergeResult> {
  return runValidation(() => {
    if (!isRecord(value)) reject("pass 2 output must be an object");
    const description = requiredText(value, "description", MAX_DESCRIPTION_CHARS, "output").replace(/\s+/g, " ");
    if (typeof value.body !== "string") reject("body must be a string");
    const body = value.body.trim();
    checkBodyShape(body, context.maxCharsPerTopic);
    const memories = parseMemories(body);
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
    const split = value.split;
    if (split !== undefined && split !== null && typeof split !== "string") reject("split must be a string or null");
    const splitText = typeof split === "string" && split.trim() !== "" ? split.trim() : null;
    if (splitText !== null && splitText.length > MAX_SPLIT_CHARS) reject(`split is longer than ${MAX_SPLIT_CHARS} chars`);
    return { description, memories, removed: parseRemoved(value.removed), split: splitText };
  });
}

export function validateUserMerge(value: unknown, maxUserChars: number): Validated<UserMergeResult> {
  return runValidation(() => {
    if (!isRecord(value)) reject("user.md output must be an object");
    if (typeof value.body !== "string") reject("body must be a string");
    const body = value.body.trim();
    checkBodyShape(body, maxUserChars);
    if (ID_MARKER.test(body)) reject("user.md must not hold memory ids");
    return { body, removed: parseRemoved(value.removed) };
  });
}
