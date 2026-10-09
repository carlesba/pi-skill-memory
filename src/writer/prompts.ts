import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { SkillIndexEntry } from "../skill-index.ts";
import type { Memory, Scope } from "../topics.ts";
import {
  MAX_CANDIDATES,
  MAX_DESCRIPTION_CHARS,
  MAX_EVIDENCE_WORDS,
  MAX_EXTRACT_PROMPT_CHARS,
  MAX_INDEX_DESCRIPTION_CHARS,
  MAX_RULE_CHARS,
  MAX_SKILL_INDEX_CHARS,
  MAX_TOPIC_INDEX_CHARS,
  MAX_WHY_CHARS,
  MIN_TRANSCRIPT_CHARS,
} from "./limits.ts";
import { truncateText, type SessionTurn } from "./session.ts";

export type PromptName = "extract" | "merge" | "merge-user";

export const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export function loadPrompt(name: PromptName, packageRoot: string = PACKAGE_ROOT): string {
  return readFileSync(join(packageRoot, "prompts", `${name}.md`), "utf8");
}

export function fillTemplate(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9]*)\}/g, (_match, key: string) => {
    if (!(key in values)) throw new Error(`prompt placeholder has no value: {${key}}`);
    return String(values[key]);
  });
}

function listOrNone(lines: string[]): string {
  return lines.length === 0 ? "(none)" : lines.join("\n");
}

function omittedLine(count: number): string {
  return `(${count} more omitted)`;
}

export function boundIndex(lines: string[], maxChars: number): string {
  if (lines.length === 0) return "(none)";
  const kept: string[] = [];
  let size = 0;
  for (const [index, line] of lines.entries()) {
    const remaining = lines.length - index - 1;
    const reserve = remaining > 0 ? omittedLine(remaining).length + 1 : 0;
    const added = (kept.length > 0 ? 1 : 0) + line.length;
    if (size + added + reserve > maxChars) break;
    kept.push(line);
    size += added;
  }
  const omitted = lines.length - kept.length;
  return omitted === 0 ? kept.join("\n") : [...kept, omittedLine(omitted)].join("\n");
}

function indexDescription(description: string): string {
  return truncateText(description, MAX_INDEX_DESCRIPTION_CHARS);
}

export interface TopicIndexEntry {
  name: string;
  description: string;
  scope: Scope;
}

export interface LoadedTopic extends TopicIndexEntry {
  memories: Memory[];
}

export interface ExtractInput {
  repos: string[];
  userMemory: string;
  topics: TopicIndexEntry[];
  skills: SkillIndexEntry[];
  loadedTopics: LoadedTopic[];
  turns: SessionTurn[];
}

function renderLoadedTopics(topics: LoadedTopic[]): string {
  if (topics.length === 0) return "(none)";
  return topics
    .map((topic) => {
      const memories = topic.memories.filter((memory) => memory.id !== null && memory.id !== "new");
      const body = memories.map((memory) => `- ${memory.id}: ${memory.text}`).join("\n");
      return `### ${topic.name} (${topic.scope})\n\n${topic.description}\n\n${body || "(no memories)"}`;
    })
    .join("\n\n");
}

export function renderTranscript(turns: SessionTurn[]): string {
  if (turns.length === 0) return "(empty)";
  return turns
    .map((turn, index) => {
      const heading = turn.human ? `User message ${index + 1}` : `Instructions from another program, message ${index + 1}`;
      const user = `### ${heading}\n\n${turn.user}`;
      return turn.assistant === null ? user : `${user}\n\n### Final assistant text after message ${index + 1}\n\n${turn.assistant}`;
    })
    .join("\n\n");
}

export function boundTurns(turns: SessionTurn[], budget: number): SessionTurn[] {
  const bounded = turns.map((turn) => ({ ...turn }));
  const size = () => renderTranscript(bounded).length;
  for (const turn of bounded) {
    if (size() <= budget) return bounded;
    turn.assistant = null;
  }
  while (size() > budget && bounded.length > 0) {
    const excess = size() - budget;
    const oldest = bounded[0]!;
    if (oldest.user.length - excess <= 1) {
      bounded.shift();
      continue;
    }
    oldest.user = truncateText(oldest.user, oldest.user.length - excess);
  }
  return bounded;
}

export function buildExtractPrompt(
  input: ExtractInput,
  template: string = loadPrompt("extract"),
  maxChars: number = MAX_EXTRACT_PROMPT_CHARS,
): string {
  const values = {
    maxCandidates: MAX_CANDIDATES,
    maxRuleChars: MAX_RULE_CHARS,
    maxWhyChars: MAX_WHY_CHARS,
    maxEvidenceWords: MAX_EVIDENCE_WORDS,
    repos: listOrNone(input.repos.map((repo) => `- ${repo}`)),
    userMemory: input.userMemory.trim() === "" ? "(empty)" : input.userMemory.trim(),
    topicIndex: boundIndex(
      input.topics.map((topic) => `- ${topic.name} (${topic.scope}): ${indexDescription(topic.description)}`),
      MAX_TOPIC_INDEX_CHARS,
    ),
    skillIndex: boundIndex(
      input.skills.map((skill) => `- ${skill.name}: ${indexDescription(skill.description)}`),
      MAX_SKILL_INDEX_CHARS,
    ),
    loadedTopics: renderLoadedTopics(input.loadedTopics),
  };
  const overhead = fillTemplate(template, { ...values, transcript: "" }).length;
  const turns = boundTurns(input.turns, Math.max(Math.min(MIN_TRANSCRIPT_CHARS, maxChars), maxChars - overhead));
  return fillTemplate(template, { ...values, transcript: renderTranscript(turns) });
}

export interface MergeCandidate {
  rule: string;
  why: string;
  evidence: string;
}

export interface MergeMemory {
  id: string;
  text: string;
  weight: number;
  learned: string;
}

export interface MergeInput {
  name: string;
  scope: Scope;
  description: string;
  memories: MergeMemory[];
  candidates: MergeCandidate[];
  descriptionFlags: string[];
  relatedTopics: TopicIndexEntry[];
  maxCharsPerTopic: number;
  maxMemoriesPerTopic: number;
}

function renderCandidates(candidates: MergeCandidate[]): string {
  return listOrNone(
    candidates.map((candidate) => {
      const evidence = candidate.evidence === "" ? "" : ` Evidence: "${candidate.evidence}"`;
      return `- ${candidate.rule} Why: ${candidate.why}${evidence}`;
    }),
  );
}

export function buildMergePrompt(input: MergeInput, template: string = loadPrompt("merge")): string {
  return fillTemplate(template, {
    maxDescriptionChars: MAX_DESCRIPTION_CHARS,
    maxCharsPerTopic: input.maxCharsPerTopic,
    maxMemoriesPerTopic: input.maxMemoriesPerTopic,
    topicName: input.name,
    scope: input.scope,
    description: input.description === "" ? "(new topic, write one)" : input.description,
    descriptionFlags: input.descriptionFlags.length === 0 ? "(none)" : input.descriptionFlags.join("; "),
    memories: listOrNone(
      input.memories.map(
        (memory) => `- ^${memory.id} (weight ${memory.weight.toFixed(2)}, learned ${memory.learned || "unknown"}): ${memory.text}`,
      ),
    ),
    candidates: renderCandidates(input.candidates),
    relatedTopics: listOrNone(input.relatedTopics.map((topic) => `- ../${topic.name}/SKILL.md: ${topic.description}`)),
  });
}

export interface UserMergeInput {
  userMemory: string;
  candidates: MergeCandidate[];
  maxUserChars: number;
}

export function buildUserMergePrompt(input: UserMergeInput, template: string = loadPrompt("merge-user")): string {
  return fillTemplate(template, {
    maxUserChars: input.maxUserChars,
    userMemory: input.userMemory.trim() === "" ? "(empty)" : input.userMemory.trim(),
    candidates: renderCandidates(input.candidates),
  });
}
