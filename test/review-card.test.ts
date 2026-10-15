import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import type { Proposal } from "../src/proposals.ts";
import { ProposalCard, proposalMarkdown, relevantHeading, unwrapParagraphs, type CardInput, type CardResult } from "../src/review-card.ts";

const plain = (_color: string, text: string) => text;
const THEME = {
  fg: plain,
  bg: plain,
  bold: (text: string) => text,
  italic: (text: string) => text,
  underline: (text: string) => text,
  strikethrough: (text: string) => text,
} as unknown as Theme;

const PROPOSAL: Proposal = {
  id: "abc1234567",
  date: "2026-10-09",
  skill: "react-code",
  rule: "Do not wrap a provider value in useMemo when its inputs change on every render.",
  why: "The memo never hits, so it saves no re-render.",
  evidence: "if not we should avoid it.",
  session: "s1",
};

const FILLER = Array.from({ length: 30 }, (_value, index) => `Line ${index} about styling and layout.`).join("\n\n");
const SKILL = `---\nname: react-code\ndescription: React rules\n---\n\n# React code\n\n## Styling\n\n${FILLER}\n\n## Providers and memo\n\nWrap provider values carefully and avoid useless memo calls.\n\n## Testing\n\nTest behaviour.\n`;

function fakeTui(rows: number): { tui: TUI; renders: () => number } {
  let renders = 0;
  const tui = { terminal: { rows, columns: 160 }, requestRender: () => void renders++ } as unknown as TUI;
  return { tui, renders: () => renders };
}

function card(input: Partial<CardInput> = {}, rows = 30) {
  const results: CardResult[] = [];
  const { tui } = fakeTui(rows);
  const component = new ProposalCard(
    tui,
    THEME,
    {
      proposal: PROPOSAL,
      comment: "",
      lastError: "",
      position: 2,
      total: 9,
      skillPath: "~/.agents/skills/react-code/SKILL.md",
      skillText: SKILL,
      ...input,
    },
    (result) => results.push(result),
  );
  return { component, results };
}

function text(lines: string[]): string {
  return lines.map((line) => stripTerminalSequences(line)).join("\n");
}

test("the wide card puts the proposal beside the skill, scrolled to the most relevant heading, within the terminal", () => {
  const { component } = card();
  const lines = component.render(140);
  assert.ok(lines.length <= 27, `${lines.length} lines`);
  for (const line of lines) assert.equal(visibleWidth(line), 140);
  const rendered = text(lines);
  assert.match(rendered, /Memory proposal 2\/9 · react-code · 2026-10-09/);
  assert.ok(lines.some((line) => /Rule Do not wrap.*~\/\.agents\/skills\/react-code\/SKILL\.md/.test(stripTerminalSequences(line))));
  assert.match(rendered, /Providers and memo/);
  assert.doesNotMatch(rendered, /Line 0 about styling/);
  assert.match(rendered, /“if not we should avoid it\.”/);
  assert.match(rendered, /› \[a\] Apply/);
  assert.match(rendered, /\[o\] Omit/);
});

test("a narrow card stacks the proposal above the skill and stays within width and height", () => {
  const { component } = card({ comment: "only the first sentence", lastError: "skipped: SKILL.md has uncommitted changes" }, 32);
  const lines = component.render(70);
  assert.ok(lines.length <= 28, `${lines.length} lines`);
  for (const line of lines) assert.equal(visibleWidth(line), 70);
  const rendered = text(lines);
  assert.ok(rendered.indexOf("Rule") < rendered.indexOf("~/.agents/skills/react-code/SKILL.md"));
  assert.match(rendered, /Comment only the first sentence/);
  assert.match(rendered, /Last apply skipped: SKILL\.md has uncommitted changes/);
  assert.match(rendered, /Providers and memo/);
});

test("single keys pick an action and Esc stops reviewing", () => {
  for (const [key, action] of [["a", "apply"], ["d", "discard"], ["o", "omit"], ["\x1b", "stop"]] as const) {
    const { component, results } = card();
    component.handleInput(key);
    assert.deepEqual(results, [{ action }], key);
  }
  const { component, results } = card();
  component.handleInput("\x1b[B");
  component.handleInput("\r");
  assert.equal(results.length, 0);
  assert.equal(component.commenting, true);
});

test("c opens a multi-line comment editor prefilled with the saved note, and Esc returns to the card", () => {
  const { component, results } = card({ comment: "under Providers" });
  component.handleInput("c");
  assert.equal(component.commenting, true);
  assert.match(text(component.render(120)), /under Providers[\s\S]*Enter saves the comment/);
  component.handleInput("\x1b");
  assert.equal(component.commenting, false);
  component.handleInput("c");
  for (const char of " now") component.handleInput(char);
  component.handleInput("\r");
  assert.deepEqual(results, [{ action: "comment", comment: "under Providers now" }]);
});

test("PgUp and PgDn scroll the skill pane", () => {
  const { component } = card({ skillText: `---\nname: react-code\n---\n\n${FILLER}\n` });
  const before = text(component.render(140));
  assert.match(before, /Line 0 about styling/);
  component.handleInput("\x1b[6~");
  const after = text(component.render(140));
  assert.doesNotMatch(after, /Line 0 about styling/);
  component.handleInput("\x1b[5~");
  assert.match(text(component.render(140)), /Line 0 about styling/);
});

test("a missing skill still renders, and the relevant heading uses token overlap", () => {
  const { component } = card({ skillText: null, skillPath: null });
  assert.match(text(component.render(120)), /No SKILL\.md found for react-code/);
  assert.equal(relevantHeading("# A\n\nnothing\n\n## Memo usage\n\nuseMemo on provider value", PROPOSAL.rule), "Memo usage");
  assert.equal(relevantHeading("# A\n\nunrelated", "zzz"), null);
  assert.match(proposalMarkdown({ proposal: PROPOSAL, comment: "", lastError: "", position: 1, total: 1, skillPath: null, skillText: null }), /^\*\*Rule\*\* Do not wrap/);
});

test("hard-wrapped skill paragraphs are joined so the pane rewraps them, leaving lists, headings and code alone", () => {
  const source = "# Title\n\nfirst half\nsecond half\n\n- item one\n  continued\n- item two\n\n```\ncode a\ncode b\n```\n";
  assert.equal(unwrapParagraphs(source), "# Title\n\nfirst half second half\n\n- item one continued\n- item two\n\n```\ncode a\ncode b\n```\n");
});
