import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Proposal } from "../src/proposals.ts";
import {
  proposalEntryData,
  proposalEntryMarkdown,
  proposalMarkdown,
  relevantHeading,
  SECTION_PREVIEW_LINES,
  skillSection,
  unwrapParagraphs,
  type CardInput,
} from "../src/review-card.ts";
import { transcriptReviewUI } from "../src/review.ts";

const PROPOSAL: Proposal = {
  id: "abc1234567",
  date: "2026-10-09",
  skill: "react-code",
  rule: "Do not wrap a provider value in useMemo when its inputs change on every render.",
  why: "The memo never hits, so it saves no re-render.",
  evidence: "if not we should avoid it.",
  session: "s1",
};

const FILLER = Array.from({ length: 40 }, (_value, index) => `- Line ${index} about providers and memo.`).join("\n");
const SKILL = `---\nname: react-code\ndescription: React rules\n---\n\n# React code\n\n## Styling\n\nStyle things.\n\n## Providers and memo\n\nWrap provider values carefully and avoid useless memo calls.\n\n### Detail\n\nNested detail.\n\n## Testing\n\nTest behaviour.\n`;

function input(overrides: Partial<CardInput> = {}): CardInput {
  return {
    proposal: PROPOSAL,
    comment: "",
    lastError: "",
    position: 2,
    total: 9,
    skillPath: "~/.agents/skills/react-code/SKILL.md",
    skillText: SKILL,
    ...overrides,
  };
}

test("the transcript entry shows the proposal and only the closest skill section with its path and line", () => {
  const markdown = proposalEntryMarkdown(proposalEntryData(input({ comment: "under Providers", lastError: "skipped: dirty" })), false);
  assert.match(markdown, /\*\*Memory proposal 2\/9\*\* · `react-code` · 2026-10-09/);
  assert.match(markdown, /\*\*Rule\*\* Do not wrap/);
  assert.match(markdown, /> “if not we should avoid it\.”/);
  assert.match(markdown, /\*\*Comment\*\* under Providers/);
  assert.match(markdown, /\*\*Last apply\*\* skipped: dirty/);
  assert.match(markdown, /Closest section by shared words, in `~\/\.agents\/skills\/react-code\/SKILL\.md:12`[\s\S]*## Providers and memo/);
  assert.match(markdown, /Nested detail/);
  assert.doesNotMatch(markdown, /Style things|Test behaviour/);
});

test("a long section is cut in the collapsed entry and shown whole when expanded", () => {
  const skill = `---\nname: react-code\n---\n\n## Providers and memo\n\n${FILLER}\n`;
  const data = proposalEntryData(input({ skillText: skill }));
  const collapsed = proposalEntryMarkdown(data, false);
  assert.match(collapsed, new RegExp(`… ${42 - SECTION_PREVIEW_LINES} more lines, ctrl\\+o expands`));
  assert.doesNotMatch(collapsed, /Line 39 about/);
  assert.match(proposalEntryMarkdown(data, true), /Line 39 about/);
});

test("skillSection falls back to the whole body when no heading matches", () => {
  assert.deepEqual(skillSection("---\nname: x\n---\n\nJust text.\n", null), { heading: null, line: 4, text: "Just text." });
  assert.equal(skillSection(SKILL, "Testing").line, 20);
});

test("a missing skill still renders, and the relevant heading uses token overlap", () => {
  assert.match(proposalEntryMarkdown(proposalEntryData(input({ skillText: null, skillPath: null })), false), /No SKILL\.md found for react-code/);
  assert.equal(relevantHeading("# A\n\nnothing\n\n## Memo usage\n\nuseMemo on provider value", PROPOSAL.rule), "Memo usage");
  assert.equal(relevantHeading("# A\n\nunrelated", "zzz"), null);
  assert.match(proposalMarkdown(input({ skillText: null })), /^\*\*Rule\*\* Do not wrap/);
});

test("hard-wrapped skill paragraphs are joined so the entry rewraps them, leaving lists, headings and code alone", () => {
  const source = "# Title\n\nfirst half\nsecond half\n\n- item one\n  continued\n- item two\n\n```\ncode a\ncode b\n```\n";
  assert.equal(unwrapParagraphs(source), "# Title\n\nfirst half second half\n\n- item one continued\n- item two\n\n```\ncode a\ncode b\n```\n");
});

function fakeUi(choices: (string | undefined)[], comments: (string | undefined)[] = []) {
  const titles: string[] = [];
  const ui = {
    select: async (title: string, options: string[]) => {
      titles.push(title);
      const choice = choices.shift();
      return choice === undefined ? undefined : options.find((option) => option.startsWith(choice));
    },
    editor: async () => comments.shift(),
  };
  return { ctx: { ui } as never, titles };
}

test("the transcript review appends the proposal once, then asks for an action in a dialog", async () => {
  const entries: unknown[] = [];
  const { ctx, titles } = fakeUi(["Comment", "Apply"], ["only the first sentence"]);
  const review = transcriptReviewUI(ctx, (_type, data) => entries.push(data));
  assert.deepEqual(await review.card(input()), { action: "comment", comment: "only the first sentence" });
  assert.deepEqual(await review.card(input({ comment: "only the first sentence" })), { action: "apply" });
  assert.equal(entries.length, 1);
  assert.match(titles[1]!, /Proposal 2\/9 for react-code · comment: only the first sentence/);
});

test("dismissing the action dialog stops reviewing", async () => {
  const { ctx } = fakeUi([undefined]);
  assert.deepEqual(await transcriptReviewUI(ctx, () => undefined).card(input()), { action: "stop" });
});
