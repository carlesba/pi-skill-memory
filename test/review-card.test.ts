import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { Proposal } from "../src/proposals.ts";
import { proposalMarkdown, relevantHeading, skillSection, unwrapParagraphs, type CardInput } from "../src/review-card.ts";

const PROPOSAL: Proposal = {
  id: "abc1234567",
  date: "2026-10-09",
  skill: "react-code",
  rule: "Do not wrap a provider value in useMemo when its inputs change on every render.",
  why: "The memo never hits, so it saves no re-render.",
  evidence: "if not we should avoid it.",
  session: "s1",
};

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

test("skillSection returns the matched heading's section, nested headings included, with its line", () => {
  const section = skillSection(SKILL, "Providers and memo");
  assert.equal(section.line, 12);
  assert.match(section.text, /^## Providers and memo[\s\S]*Nested detail\.$/);
  assert.doesNotMatch(section.text, /Test behaviour/);
});

test("skillSection falls back to the whole body when no heading matches", () => {
  assert.deepEqual(skillSection("---\nname: x\n---\n\nJust text.\n", null), { heading: null, line: 4, text: "Just text." });
  assert.equal(skillSection(SKILL, "Testing").line, 20);
});

test("the relevant heading uses token overlap, and proposal markdown leads with the rule", () => {
  assert.equal(relevantHeading("# A\n\nnothing\n\n## Memo usage\n\nuseMemo on provider value", PROPOSAL.rule), "Memo usage");
  assert.equal(relevantHeading("# A\n\nunrelated", "zzz"), null);
  assert.match(proposalMarkdown(input({ skillText: null, comment: "under Providers" })), /^\*\*Rule\*\* Do not wrap[\s\S]*\*\*Comment\*\* under Providers/);
});

test("hard-wrapped skill paragraphs are joined so the entry rewraps them, leaving lists, headings and code alone", () => {
  const source = "# Title\n\nfirst half\nsecond half\n\n- item one\n  continued\n- item two\n\n```\ncode a\ncode b\n```\n";
  assert.equal(unwrapParagraphs(source), "# Title\n\nfirst half second half\n\n- item one continued\n- item two\n\n```\ncode a\ncode b\n```\n");
});
