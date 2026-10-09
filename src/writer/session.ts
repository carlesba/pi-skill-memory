import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, relative, resolve } from "node:path";
import { DEFAULT_LEARN_FROM_SOURCES, humanMessageTimestamps, isUserMessageFrom, messageText, type InputSource } from "../human.ts";
import { extractToolPaths } from "../paths.ts";
import { createRepoResolver, type RepoResolver } from "../repo.ts";
import { topicsRoot } from "../topics.ts";
import { isInside } from "./confine.ts";

export const MAX_USER_MESSAGE_CHARS = 2000;
export const MAX_ASSISTANT_TEXT_CHARS = 1500;

export interface SessionTurn {
  user: string;
  human: boolean;
  assistant: string | null;
}

export interface SessionDigest {
  sessionId: string;
  cwd: string;
  turns: SessionTurn[];
  repos: string[];
  memoryReads: string[];
}

export interface ReadSessionOptions {
  dir: string;
  resolver?: RepoResolver;
  home?: string;
  learnFromSources?: readonly InputSource[];
}

interface RawEntry {
  type?: unknown;
  id?: unknown;
  parentId?: unknown;
  cwd?: unknown;
  message?: unknown;
}

interface ToolCallBlock {
  name: string;
  arguments: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function truncateText(text: string, limit: number): string {
  if (text.length <= limit) return text;
  if (limit <= 1) return text.slice(0, limit);
  return `${text.slice(0, limit - 1)}…`;
}

function parseLines(raw: string): RawEntry[] {
  const entries: RawEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const value: unknown = JSON.parse(line);
      if (isRecord(value)) entries.push(value);
    } catch {
      continue;
    }
  }
  return entries;
}

function activeBranch(entries: RawEntry[]): RawEntry[] {
  const withIds = entries.filter((entry) => entry.type !== "session" && typeof entry.id === "string");
  if (withIds.length === 0) return [];
  const byId = new Map(withIds.map((entry) => [entry.id as string, entry]));
  const branch: RawEntry[] = [];
  const seen = new Set<string>();
  let current: RawEntry | undefined = withIds[withIds.length - 1];
  while (current && !seen.has(current.id as string)) {
    seen.add(current.id as string);
    branch.push(current);
    current = typeof current.parentId === "string" ? byId.get(current.parentId) : undefined;
  }
  return branch.reverse();
}

function toolCallsOf(content: unknown): ToolCallBlock[] {
  if (!Array.isArray(content)) return [];
  return content
    .filter((block) => isRecord(block) && block.type === "toolCall" && typeof block.name === "string")
    .map((block) => ({ name: (block as Record<string, unknown>).name as string, arguments: (block as Record<string, unknown>).arguments }));
}

function lastTextBlock(content: unknown): string | null {
  if (!Array.isArray(content)) return typeof content === "string" && content.trim() !== "" ? content : null;
  for (let index = content.length - 1; index >= 0; index--) {
    const block = content[index];
    if (isRecord(block) && block.type === "text" && typeof block.text === "string" && block.text.trim() !== "") {
      return block.text;
    }
  }
  return null;
}

export function memoryTopicOfPath(path: string, dir: string): string | null {
  if (basename(path) !== "SKILL.md") return null;
  const rel = relative(topicsRoot(dir), dirname(path));
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes("/") || rel.includes("\\")) return null;
  return rel;
}

export function parseSession(raw: string, options: ReadSessionOptions): SessionDigest {
  const entries = parseLines(raw);
  const header = entries.find((entry) => entry.type === "session");
  const sessionId = typeof header?.id === "string" ? header.id : "";
  const cwd = typeof header?.cwd === "string" ? header.cwd : process.cwd();
  const home = options.home ?? homedir();
  const resolver = options.resolver ?? createRepoResolver();
  const turns: SessionTurn[] = [];
  const touchedPaths = new Set<string>([cwd]);
  const memoryReads = new Set<string>();
  const branch = activeBranch(entries);
  const humanTimestamps = humanMessageTimestamps(branch, options.learnFromSources ?? DEFAULT_LEARN_FROM_SOURCES);
  for (const entry of branch) {
    if (entry.type !== "message" || !isRecord(entry.message)) continue;
    const message = entry.message;
    if (message.role === "user") {
      const text = messageText(message.content).trim();
      if (text === "") continue;
      turns.push({ user: truncateText(text, MAX_USER_MESSAGE_CHARS), human: isUserMessageFrom(entry, humanTimestamps), assistant: null });
      continue;
    }
    if (message.role !== "assistant") continue;
    const finalText = lastTextBlock(message.content);
    if (finalText !== null && turns.length > 0) {
      turns[turns.length - 1]!.assistant = truncateText(finalText.trim(), MAX_ASSISTANT_TEXT_CHARS);
    }
    for (const call of toolCallsOf(message.content)) {
      for (const path of extractToolPaths(call.name, call.arguments, cwd, home)) {
        if (isInside(path, options.dir)) {
          const topic = call.name === "read" ? memoryTopicOfPath(resolve(path), options.dir) : null;
          if (topic) memoryReads.add(topic);
          continue;
        }
        touchedPaths.add(path);
      }
    }
  }
  const repos = new Set<string>();
  for (const path of touchedPaths) {
    const identity = resolver.resolvePath(path)?.identity;
    if (identity) repos.add(identity);
  }
  return { sessionId, cwd, turns, repos: [...repos].sort(), memoryReads: [...memoryReads].sort() };
}

export function readSession(file: string, options: ReadSessionOptions): SessionDigest {
  return parseSession(readFileSync(file, "utf8"), options);
}
