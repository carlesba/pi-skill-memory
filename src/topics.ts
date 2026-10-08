import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseFrontmatter, quoteScalar } from "./frontmatter.ts";
import { repoName, repoOwner } from "./repo.ts";

export type Scope = "generic" | `repo:${string}`;

export interface Memory {
  id: string | null;
  text: string;
}

export interface TopicFile {
  name: string;
  description: string;
  scope: Scope;
  updated: string;
  memories: Memory[];
}

export interface TopicSummary {
  name: string;
  description: string;
  scope: Scope;
  updated: string;
  path: string;
}

export const MEMORY_SKILLS_DIR = "memory-skills";
export const MAX_SKILL_NAME_LENGTH = 64;

const MEMORY_ID_SUFFIX = /^([\s\S]*?)\s*\^(r\d+|new)\s*$/;

export function parseScope(value: string | undefined): Scope | null {
  if (value === undefined) return null;
  const trimmed = value.trim();
  if (trimmed === "generic") return "generic";
  const match = /^repo:([^\s/]+(?:\/[^\s/]+)+)$/i.exec(trimmed);
  return match ? `repo:${match[1]!.toLowerCase()}` : null;
}

export function scopeIdentity(scope: Scope): string | null {
  return scope === "generic" ? null : scope.slice("repo:".length);
}

export function parseMemories(body: string): Memory[] {
  return body
    .replace(/\r\n/g, "\n")
    .split(/\n[ \t]*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph !== "")
    .map((paragraph) => {
      const match = MEMORY_ID_SUFFIX.exec(paragraph);
      return match ? { id: match[2]!, text: match[1]!.trim() } : { id: null, text: paragraph };
    });
}

export function serializeMemories(memories: Memory[]): string {
  return memories.map((memory) => (memory.id ? `${memory.text} ^${memory.id}` : memory.text)).join("\n\n");
}

export function memoryIds(body: string): string[] {
  return parseMemories(body)
    .map((memory) => memory.id)
    .filter((id): id is string => id !== null && id !== "new");
}

export function withoutMemories(memories: Memory[], ids: Iterable<string>): Memory[] {
  const removed = new Set(ids);
  return memories.filter((memory) => memory.id === null || !removed.has(memory.id));
}

export function parseTopic(raw: string): TopicFile | null {
  const parsed = parseFrontmatter(raw);
  if (!parsed) return null;
  const name = parsed.fields.name?.trim();
  const description = parsed.fields.description?.trim();
  const metadata = parsed.maps.metadata ?? {};
  const scope = parseScope(metadata.scope);
  if (!name || !description || !scope) return null;
  return {
    name,
    description,
    scope,
    updated: metadata.updated?.trim() ?? "",
    memories: parseMemories(parsed.body),
  };
}

export function serializeTopic(topic: TopicFile): string {
  const frontmatter = [
    "---",
    `name: ${topic.name}`,
    `description: ${quoteScalar(topic.description)}`,
    "metadata:",
    `  scope: ${quoteScalar(topic.scope)}`,
    `  updated: ${quoteScalar(topic.updated)}`,
    "---",
  ].join("\n");
  const body = serializeMemories(topic.memories);
  return body === "" ? `${frontmatter}\n` : `${frontmatter}\n\n${body}\n`;
}

export function topicsRoot(dir: string): string {
  return join(dir, MEMORY_SKILLS_DIR);
}

export function topicSkillPath(dir: string, name: string): string {
  return join(topicsRoot(dir), name, "SKILL.md");
}

export function topicLedgerPath(dir: string, name: string): string {
  return join(topicsRoot(dir), name, "ledger.json");
}

export function listTopics(dir: string): TopicSummary[] {
  let entries: string[];
  try {
    entries = readdirSync(topicsRoot(dir));
  } catch {
    return [];
  }
  const topics: TopicSummary[] = [];
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue;
    const path = topicSkillPath(dir, entry);
    let raw: string;
    try {
      raw = readFileSync(path, "utf8");
    } catch {
      continue;
    }
    const topic = parseTopic(raw);
    if (!topic) continue;
    topics.push({ name: topic.name, description: topic.description, scope: topic.scope, updated: topic.updated, path });
  }
  return topics;
}

export function topicAppliesToRepo(scope: Scope, identity: string | null): boolean {
  if (scope === "generic") return true;
  return identity !== null && scopeIdentity(scope) === identity.toLowerCase();
}

export function topicsForRepo<T extends { scope: Scope }>(topics: T[], identity: string | null): T[] {
  return topics.filter((topic) => topicAppliesToRepo(topic.scope, identity));
}

export function repoTopics<T extends { scope: Scope }>(topics: T[], identity: string): T[] {
  return topics.filter((topic) => topic.scope !== "generic" && topicAppliesToRepo(topic.scope, identity));
}

export function discoverSkillPaths(topics: TopicSummary[], identity: string | null): string[] {
  return topicsForRepo(topics, identity).map((topic) => topic.path);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

function capSlug(value: string, length: number): string {
  return value.slice(0, length).replace(/-+$/, "");
}

export function scopeSlug(scope: Scope, existing: { name: string; scope: Scope }[]): string {
  if (scope === "generic") return "any";
  const identity = scopeIdentity(scope)!;
  const short = slugify(repoName(identity));
  const long = slugify(`${repoOwner(identity)}-${repoName(identity)}`);
  const own = existing.filter((topic) => topic.scope === scope);
  if (own.some((topic) => topic.name.startsWith(`mem-${long}-`))) return long;
  if (own.some((topic) => topic.name.startsWith(`mem-${short}-`))) return short;
  if (short === "" || short === "any") return long;
  const takenByOther = existing.some(
    (topic) =>
      topic.scope !== "generic" &&
      topic.scope !== scope &&
      slugify(repoName(scopeIdentity(topic.scope)!)) === short &&
      topic.name.startsWith(`mem-${short}-`),
  );
  return takenByOther ? long : short;
}

export function topicBaseName(scope: Scope, topic: string, existing: { name: string; scope: Scope }[]): string {
  const topicSlug = slugify(topic) || "notes";
  return capSlug(`mem-${scopeSlug(scope, existing)}-${topicSlug}`, MAX_SKILL_NAME_LENGTH);
}

export function mintTopicName(scope: Scope, topic: string, existing: { name: string; scope: Scope }[]): string {
  const base = topicBaseName(scope, topic, existing);
  const taken = new Set(existing.map((entry) => entry.name));
  if (!taken.has(base)) return base;
  for (let suffix = 2; ; suffix++) {
    const tail = `-${suffix}`;
    const candidate = `${capSlug(base, MAX_SKILL_NAME_LENGTH - tail.length)}${tail}`;
    if (!taken.has(candidate)) return candidate;
  }
}
