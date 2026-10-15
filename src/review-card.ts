import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  HStack,
  Key,
  Markdown,
  matchesKey,
  ScrollView,
  stripTerminalSequences,
  Text,
  truncateToWidth,
  visibleWidth,
  VStack,
  type Component,
  type EditorTheme,
  type Focusable,
  type MarkdownTheme,
  type SelectListTheme,
  type TUI,
} from "@earendil-works/pi-tui";
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

export const WIDE_CARD_COLUMNS = 110;
export const MAX_SKILL_ROWS = 18;
export const MIN_STACKED_SKILL_ROWS = 5;

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

function selectListTheme(theme: Theme): SelectListTheme {
  return {
    selectedPrefix: (text) => theme.fg("accent", text),
    selectedText: (text) => theme.fg("accent", text),
    description: (text) => theme.fg("muted", text),
    scrollInfo: (text) => theme.fg("dim", text),
    noMatch: (text) => theme.fg("warning", text),
  };
}

function editorTheme(theme: Theme): EditorTheme {
  return { borderColor: (text) => theme.fg("accent", text), selectList: selectListTheme(theme) };
}

export class Viewport implements Component {
  readonly scroll: ScrollView;
  height = 1;
  private readonly requestRender: () => void;
  private readonly anchor: string | null;
  private scrolledByUser = false;

  constructor(content: Component, requestRender: () => void, anchor: string | null = null) {
    this.scroll = new ScrollView(content);
    this.requestRender = requestRender;
    this.anchor = anchor;
  }

  scrollBy(lines: number): void {
    this.scrolledByUser = true;
    this.scroll.scrollBy(lines);
  }

  invalidate(): void {
    this.scroll.invalidate();
  }

  render(width: number): string[] {
    const lines = this.scroll.render(width);
    this.scroll.updateLayout(lines.length, this.height, this.requestRender);
    if (!this.scrolledByUser && this.anchor !== null) {
      const needle = this.anchor.slice(0, 40);
      const index = lines.findIndex((line) => stripTerminalSequences(line).includes(needle));
      if (index >= 0) this.scroll.scrollTo(Math.max(0, index - 1));
    }
    const top = this.scroll.scrollTop;
    const visible = lines.slice(top, top + this.height);
    while (visible.length < this.height) visible.push("");
    return visible;
  }
}

export class ProposalCard implements Component, Focusable {
  private mode: "card" | "comment" = "card";
  private selected = 0;
  private readonly editor: Editor;
  private readonly proposalPane: Viewport;
  private readonly skillPane: Viewport;
  private readonly proposalText: Markdown;
  private readonly skillTitle: Text;
  private focusedState = false;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly input: CardInput;
  private readonly done: (result: CardResult) => void;

  constructor(tui: TUI, theme: Theme, input: CardInput, done: (result: CardResult) => void) {
    this.tui = tui;
    this.theme = theme;
    this.input = input;
    this.done = done;
    const md = markdownTheme(theme);
    this.proposalText = new Markdown(proposalMarkdown(input), 0, 0, md);
    this.proposalPane = new Viewport(this.proposalText, () => tui.requestRender());
    const body = input.skillText === null ? `*No SKILL.md found for ${input.proposal.skill} in the skill index.*` : skillBody(input.skillText);
    const anchor = input.skillText === null ? null : relevantHeading(body, `${input.proposal.rule} ${input.proposal.why}`);
    this.skillPane = new Viewport(new Markdown(body, 0, 0, md), () => tui.requestRender(), anchor);
    this.skillTitle = new Text(theme.fg("dim", input.skillPath ?? input.proposal.skill), 0, 0);
    this.editor = new Editor(tui, editorTheme(theme));
    this.editor.setText(input.comment);
    this.editor.onSubmit = (text) => this.done({ action: "comment", comment: text.trim() });
  }

  get focused(): boolean {
    return this.focusedState;
  }

  set focused(value: boolean) {
    this.focusedState = value;
    this.editor.focused = value && this.mode === "comment";
  }

  get commenting(): boolean {
    return this.mode === "comment";
  }

  private refresh(): void {
    this.tui.requestRender();
  }

  private act(value: string): void {
    if (value === "comment") {
      this.mode = "comment";
      this.editor.focused = this.focusedState;
      this.refresh();
      return;
    }
    if (value === "apply" || value === "discard" || value === "omit") this.done({ action: value });
  }

  handleInput(data: string): void {
    if (this.mode === "comment") {
      if (matchesKey(data, Key.escape)) {
        this.mode = "card";
        this.editor.focused = false;
        this.editor.setText(this.input.comment);
        this.refresh();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }
    const shortcut = CARD_ACTIONS.find((action) => data === action.key);
    if (shortcut) {
      this.act(shortcut.value);
      return;
    }
    if (matchesKey(data, Key.escape)) {
      this.done({ action: "stop" });
      return;
    }
    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.shift("down"))) {
      this.skillPane.scrollBy(matchesKey(data, Key.pageDown) ? Math.max(1, this.skillPane.height - 2) : 1);
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.shift("up"))) {
      this.skillPane.scrollBy(matchesKey(data, Key.pageUp) ? -Math.max(1, this.skillPane.height - 2) : -1);
      this.refresh();
      return;
    }
    const step = matchesKey(data, Key.right) || matchesKey(data, Key.down) || matchesKey(data, Key.tab) ? 1
      : matchesKey(data, Key.left) || matchesKey(data, Key.up) ? -1
      : 0;
    if (step !== 0) {
      this.selected = (this.selected + step + CARD_ACTIONS.length) % CARD_ACTIONS.length;
      this.refresh();
      return;
    }
    if (matchesKey(data, Key.enter)) this.act(CARD_ACTIONS[this.selected]!.value);
  }

  invalidate(): void {
    this.proposalText.invalidate();
    this.skillPane.invalidate();
    this.editor.invalidate?.();
  }

  private budget(): number {
    const rows = this.tui.terminal.rows || 40;
    return Math.max(14, Math.floor(rows * 0.8));
  }

  private actionBar(): string {
    return CARD_ACTIONS.map((action, index) => {
      const label = `[${action.key}] ${action.label}`;
      return index === this.selected ? this.theme.fg("accent", this.theme.bold(`› ${label}`)) : this.theme.fg("muted", `  ${label}`);
    }).join("  ");
  }

  private contentHeight(innerWidth: number, footerRows: number): number {
    const wide = innerWidth >= WIDE_CARD_COLUMNS;
    const proposalWidth = wide ? Math.floor(((innerWidth - 2) * 2) / 5) : innerWidth;
    const proposalRows = this.proposalText.render(proposalWidth).length;
    const wanted = wide ? Math.max(proposalRows, MAX_SKILL_ROWS) : proposalRows + 2 + MAX_SKILL_ROWS;
    return Math.max(4, Math.min(wanted, this.budget() - footerRows - 4));
  }

  render(width: number): string[] {
    const safeWidth = Math.max(24, width);
    const inner = safeWidth - 4;
    const border = (text: string) => this.theme.fg("border", text);
    const row = (line: string) => {
      const fitted = truncateToWidth(line, inner);
      return `${border("│")} ${fitted}${" ".repeat(Math.max(0, inner - visibleWidth(fitted)))} ${border("│")}`;
    };
    const rule = (left: string, right: string) => border(`${left}${"─".repeat(safeWidth - 2)}${right}`);
    const heading = ` ${this.theme.bold("Memory proposal")} ${this.theme.fg("muted", `${this.input.position}/${this.input.total} · ${this.input.proposal.skill} · ${this.input.proposal.date}`)} `;
    const top = border("╭─") + truncateToWidth(heading, safeWidth - 4) + border(`${"─".repeat(Math.max(0, safeWidth - 3 - visibleWidth(truncateToWidth(heading, safeWidth - 4))))}╮`);
    const footer =
      this.mode === "comment"
        ? [...this.editor.render(inner), this.theme.fg("dim", "Enter saves the comment · Shift+Enter new line · Esc cancels")]
        : [this.actionBar(), this.theme.fg("dim", "←→ Enter or a/c/d/o · PgUp/PgDn scroll the skill · Esc stops")];
    const bodyHeight = this.contentHeight(inner, footer.length);
    const body = inner >= WIDE_CARD_COLUMNS ? this.renderWide(inner, bodyHeight) : this.renderStacked(inner, bodyHeight);
    return [top, ...body.map(row), rule("├", "┤"), ...footer.map(row), rule("╰", "╯")];
  }

  private renderWide(width: number, height: number): string[] {
    this.proposalPane.height = height;
    this.skillPane.height = height - 1;
    const right = new VStack([this.skillTitle, this.skillPane]);
    return new HStack(
      [
        { component: this.proposalPane, basis: 0, grow: 2 },
        { component: right, basis: 0, grow: 3 },
      ],
      { gap: 2 },
    ).render(width);
  }

  private renderStacked(width: number, height: number): string[] {
    const proposalLines = this.proposalText.render(width).length;
    this.proposalPane.height = Math.max(3, Math.min(proposalLines, height - 2 - MIN_STACKED_SKILL_ROWS));
    this.skillPane.height = Math.max(2, height - this.proposalPane.height - 2);
    const divider = new Text(this.theme.fg("borderMuted", "┄".repeat(width)), 0, 0);
    return new VStack([this.proposalPane, divider, this.skillTitle, this.skillPane]).render(width);
  }
}
