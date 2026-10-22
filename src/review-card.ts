import { splitFrontmatter } from "./frontmatter.ts";
import type { Proposal } from "./proposals.ts";

export type CardResult =
  | { action: "apply" }
  | { action: "discard" }
  | { action: "omit" }
  | { action: "stop" }
  | { action: "comment"; comment: string };

export interface CardInput {
  proposal: Proposal;
  comment: string;
  lastError: string;
  position: number;
  total: number;
  skillPath: string | null;
  skillText: string | null;
}

export const CARD_ACTIONS: { key: string; value: "apply" | "comment" | "discard" | "omit"; label: string; description: string }[] = [
  { key: "a", value: "apply", label: "Apply", description: "queue it for the background apply job" },
  { key: "c", value: "comment", label: "Comment…", description: "add an instruction for the apply job" },
  { key: "d", value: "discard", label: "Discard", description: "delete it from proposals.md" },
  { key: "o", value: "omit", label: "Omit", description: "ask again in 24 hours" },
];


const STOPWORDS = new Set([
  "about", "after", "also", "because", "before", "being", "between", "does", "each", "every", "from", "have", "into",
  "keep", "more", "must", "only", "other", "should", "since", "some", "than", "that", "their", "them", "then", "there",
  "these", "they", "this", "through", "when", "where", "which", "while", "will", "with", "without", "would", "your",
]);

function tokens(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
  );
}

function plainHeading(text: string): string {
  return text.replace(/[`*_~[\]]/g, "").replace(/\s+/g, " ").trim();
}

export function relevantHeading(markdown: string, text: string): string | null {
  const wanted = tokens(text);
  if (wanted.size === 0) return null;
  const sections: { heading: string; body: string[] }[] = [];
  for (const line of markdown.split("\n")) {
    const heading = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) sections.push({ heading: plainHeading(heading[1]!), body: [heading[1]!] });
    else sections.at(-1)?.body.push(line);
  }
  let best: { heading: string; score: number } | null = null;
  for (const section of sections) {
    const words = tokens(section.body.join(" "));
    let score = 0;
    for (const word of wanted) if (words.has(word)) score++;
    if (score > 0 && (!best || score > best.score)) best = { heading: section.heading, score };
  }
  return best?.heading ?? null;
}

const BLOCK_LINE = /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\||```|~~~|<|$)/;

export function unwrapParagraphs(markdown: string): string {
  const out: string[] = [];
  let fenced = false;
  for (const line of markdown.split("\n")) {
    if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
    const previous = out.at(-1);
    const continues = !fenced && previous !== undefined && previous.trim() !== "" && !/^\s*(```|~~~|#{1,6}\s|\|)/.test(previous) && !BLOCK_LINE.test(line);
    if (continues) out[out.length - 1] = `${previous.trimEnd()} ${line.trim()}`;
    else out.push(line);
  }
  return out.join("\n");
}

export function skillBody(text: string): string {
  return unwrapParagraphs(splitFrontmatter(text)?.body ?? text);
}

export const APPLY_FAILED_HINT = "Fix the cause, then Apply to retry it or Discard to drop it.";

export function proposalMarkdown(input: CardInput): string {
  const { proposal } = input;
  const parts = input.lastError === "" ? [] : [`**⚠ Apply failed and needs you** ${input.lastError}`, APPLY_FAILED_HINT];
  parts.push(
    `**Rule** ${proposal.rule}`,
    `**Why** ${proposal.why}`,
  );
  if (proposal.evidence !== "") parts.push(`> “${proposal.evidence}”`);
  if (input.comment.trim() !== "") parts.push(`**Comment** ${input.comment.trim()}`);
  return parts.join("\n\n");
}


export interface SkillSection {
  heading: string | null;
  line: number;
  text: string;
}

export function skillSection(skillText: string, heading: string | null): SkillSection {
  const lines = skillText.split("\n");
  const bodyStart = skillText.startsWith("---") ? lines.findIndex((line, index) => index > 0 && line.trim() === "---") + 1 : 0;
  const level = (line: string) => /^(#{1,6})\s/.exec(line)?.[1]!.length ?? 0;
  const start = heading === null ? -1 : lines.findIndex((line, index) => index >= bodyStart && level(line) > 0 && plainHeading(line.replace(/^#{1,6}\s+/, "").replace(/\s*#*\s*$/, "")) === heading);
  if (start < 0) return { heading: null, line: bodyStart + 1, text: lines.slice(bodyStart).join("\n").trim() };
  const depth = level(lines[start]!);
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index++) {
    const current = level(lines[index]!);
    if (current > 0 && current <= depth) {
      end = index;
      break;
    }
  }
  return { heading, line: start + 1, text: lines.slice(start, end).join("\n").trim() };
}
