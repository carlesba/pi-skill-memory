import type { Theme } from "@earendil-works/pi-coding-agent";
import { Box, Markdown, type Component, type MarkdownTheme } from "@earendil-works/pi-tui";
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

export function proposalMarkdown(input: CardInput): string {
  const { proposal } = input;
  const parts = [
    `**Rule** ${proposal.rule}`,
    `**Why** ${proposal.why}`,
  ];
  if (proposal.evidence !== "") parts.push(`> “${proposal.evidence}”`);
  if (input.comment.trim() !== "") parts.push(`**Comment** ${input.comment.trim()}`);
  if (input.lastError !== "") parts.push(`**Last apply** ${input.lastError}`);
  return parts.join("\n\n");
}

export function markdownTheme(theme: Theme): MarkdownTheme {
  return {
    heading: (text) => theme.fg("mdHeading", text),
    link: (text) => theme.fg("mdLink", text),
    linkUrl: (text) => theme.fg("mdLinkUrl", text),
    code: (text) => theme.fg("mdCode", text),
    codeBlock: (text) => theme.fg("mdCodeBlock", text),
    codeBlockBorder: (text) => theme.fg("mdCodeBlockBorder", text),
    quote: (text) => theme.fg("mdQuote", text),
    quoteBorder: (text) => theme.fg("mdQuoteBorder", text),
    hr: (text) => theme.fg("mdHr", text),
    listBullet: (text) => theme.fg("mdListBullet", text),
    bold: (text) => theme.bold(text),
    italic: (text) => theme.italic(text),
    strikethrough: (text) => theme.strikethrough(text),
    underline: (text) => theme.underline(text),
  };
}

export const PROPOSAL_ENTRY = "pi-skill-memory-proposal";
export const SECTION_PREVIEW_LINES = 30;

export interface SkillSection {
  heading: string | null;
  line: number;
  text: string;
}

export interface ProposalEntryData {
  input: Omit<CardInput, "skillText">;
  section: SkillSection | null;
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

export function proposalEntryData(input: CardInput): ProposalEntryData {
  const { skillText, ...rest } = input;
  if (skillText === null) return { input: rest, section: null };
  const body = skillBody(skillText);
  return { input: rest, section: skillSection(skillText, relevantHeading(body, `${input.proposal.rule} ${input.proposal.why}`)) };
}

export function proposalEntryMarkdown(data: ProposalEntryData, expanded: boolean): string {
  const { input, section } = data;
  const parts = [`**Memory proposal ${input.position}/${input.total}** · \`${input.proposal.skill}\` · ${input.proposal.date}`, proposalMarkdown({ ...input, skillText: null })];
  if (section === null) {
    parts.push(`*No SKILL.md found for ${input.proposal.skill} in the skill index.*`);
    return parts.join("\n\n");
  }
  const where = `${input.skillPath ?? input.proposal.skill}:${section.line}`;
  const lines = unwrapParagraphs(section.text).split("\n");
  const cut = !expanded && lines.length > SECTION_PREVIEW_LINES;
  parts.push("---", `*Closest section by shared words, in \`${where}\`:*`, (cut ? lines.slice(0, SECTION_PREVIEW_LINES) : lines).join("\n"));
  if (cut) parts.push(`*… ${lines.length - SECTION_PREVIEW_LINES} more lines, ctrl+o expands*`);
  return parts.join("\n\n");
}

export function proposalEntryComponent(data: ProposalEntryData, expanded: boolean, theme: Theme): Component {
  const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
  box.addChild(new Markdown(proposalEntryMarkdown(data, expanded), 0, 0, markdownTheme(theme)));
  return box;
}
