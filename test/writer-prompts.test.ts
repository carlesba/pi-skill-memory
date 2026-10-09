import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  boundIndex,
  boundTurns,
  buildExtractPrompt,
  buildMergePrompt,
  buildUserMergePrompt,
  fillTemplate,
  renderTranscript,
} from "../src/writer/prompts.ts";

test("fills placeholders once and refuses unknown ones", () => {
  assert.equal(fillTemplate("a {x} {\"json\": 1}", { x: "{y}" }), "a {y} {\"json\": 1}");
  assert.throws(() => fillTemplate("{missing}", {}), /missing/);
});

test("the packaged prompts fill without leftover placeholders", () => {
  const extract = buildExtractPrompt({
    repos: ["acme/app"],
    userMemory: "",
    topics: [{ name: "mem-any-testing", description: "When writing tests", scope: "generic" }],
    skills: [{ name: "git", description: "Git workflow", path: "/s" }],
    loadedTopics: [],
    turns: [{ user: "hello", human: true, assistant: "hi" }],
  });
  assert.match(extract, /- acme\/app/);
  assert.match(extract, /At most 20 candidates/);
  assert.match(extract, /never take a lesson, a vote or an evidence quote from them/);
  assert.doesNotMatch(extract, /\{[a-zA-Z]+\}/);
  const merge = buildMergePrompt({
    name: "mem-any-testing",
    scope: "generic",
    description: "",
    memories: [
      { id: "r1", text: "Use node:test.", weight: 1, learned: "2025-01-01", origin: "human" },
      { id: "r2", text: "The CI runs on Node 22.", weight: 3, learned: "2025-02-01", origin: "observed" },
    ],
    candidates: [{ rule: "Never vitest.", why: "Zero deps.", evidence: "never vitest" }],
    descriptionFlags: [],
    relatedTopics: [],
    maxCharsPerTopic: 4000,
    maxMemoriesPerTopic: 12,
  });
  assert.match(merge, /\^r1 \(origin human, weight 1\.00, learned 2025-01-01\): Use node:test\./);
  assert.match(merge, /\^r2 \(origin observed, weight 3\.00, learned 2025-02-01\): The CI runs on Node 22\./);
  assert.match(merge, /A human memory always beats an observed one, whatever their age or weight\./);
  assert.doesNotMatch(merge, /\{[a-zA-Z]+\}/);
  const user = buildUserMergePrompt({ userMemory: "Be terse.", candidates: [], maxUserChars: 4000 });
  assert.match(user, /at most 4000 characters/);
  assert.doesNotMatch(user, /\{[a-zA-Z]+\}/);
});

test("bounds the transcript by dropping oldest assistant texts, then truncating oldest user messages", () => {
  const turns = [
    { user: "u1".repeat(50), human: true, assistant: "a1".repeat(50) },
    { user: "u2".repeat(50), human: true, assistant: "a2".repeat(50) },
  ];
  const full = renderTranscript(turns).length;
  const oneDropped = boundTurns(turns, full - 10);
  assert.equal(oneDropped[0]!.assistant, null);
  assert.notEqual(oneDropped[1]!.assistant, null);
  const tight = boundTurns(turns, renderTranscript([{ user: "u2".repeat(50), human: true, assistant: null }]).length + 60);
  assert.ok(tight.every((turn) => turn.assistant === null));
  assert.ok(renderTranscript(tight).length <= renderTranscript([{ user: "u2".repeat(50), human: true, assistant: null }]).length + 60);
  assert.equal(tight[tight.length - 1]!.user, "u2".repeat(50));
  const prompt = buildExtractPrompt(
    { repos: [], userMemory: "", topics: [], skills: [], loadedTopics: [], turns: [{ user: "x".repeat(70_000), human: true, assistant: null }] },
    "head {maxCandidates}{maxRuleChars}{maxWhyChars}{maxEvidenceWords}{repos}{userMemory}{topicIndex}{skillIndex}{loadedTopics}{transcript}",
  );
  assert.ok(prompt.length <= 60_000);
});

test("a huge skill and topic index still leaves the user messages in the extract prompt", () => {
  const skills = Array.from({ length: 300 }, (_, index) => ({
    name: `skill-${index}`,
    description: `Skill ${index} ${"d".repeat(1000)}`,
    path: `/skills/${index}`,
  }));
  const topics = Array.from({ length: 200 }, (_, index) => ({
    name: `mem-any-topic-${index}`,
    description: `Topic ${index} ${"t".repeat(300)}`,
    scope: "generic" as const,
  }));
  const turns = Array.from({ length: 12 }, (_, index) => ({ user: `user message ${index} ${"u".repeat(1900)}`, human: true, assistant: "a".repeat(1400) }));
  const prompt = buildExtractPrompt({ repos: ["acme/app"], userMemory: "Be terse.", topics, skills, loadedTopics: [], turns });
  assert.ok(prompt.length <= 60_000, `prompt is ${prompt.length} chars`);
  for (let index = 0; index < turns.length; index++) assert.match(prompt, new RegExp(`user message ${index} u`));
  assert.match(prompt, /- skill-0: Skill 0 d+…\n/);
  assert.doesNotMatch(prompt, /d{200}/);
  assert.match(prompt, /\(\d+ more omitted\)/);
  assert.match(prompt, /- mem-any-topic-0 \(generic\): Topic 0 t+…\n/);
});

test("pass 1 marks human messages as the user's and other user-role text as program instructions", () => {
  const transcript = renderTranscript([
    { user: "Review the parser. Report findings only.", human: false, assistant: "Two findings." },
    { user: "Always run the linter before committing.", human: true, assistant: null },
  ]);
  assert.equal(
    transcript,
    [
      "### Instructions from another program, message 1",
      "",
      "Review the parser. Report findings only.",
      "",
      "### Final assistant text after message 1",
      "",
      "Two findings.",
      "",
      "### User message 2",
      "",
      "Always run the linter before committing.",
    ].join("\n"),
  );
  const prompt = buildExtractPrompt({
    repos: [],
    userMemory: "",
    topics: [],
    skills: [],
    loadedTopics: [],
    turns: [{ user: "Fix the build.", human: false, assistant: null }],
  });
  assert.match(prompt, /### Instructions from another program, message 1\n\nFix the build\./);
  assert.doesNotMatch(prompt, /### User message 1/);
});

test("index sections keep whole entries within their cap and count what they drop", () => {
  const lines = ["- a: one", "- b: two", "- c: three", "- d: four"];
  assert.equal(boundIndex([], 100), "(none)");
  assert.equal(boundIndex(lines, 1000), lines.join("\n"));
  const bounded = boundIndex(lines, 40);
  assert.ok(bounded.length <= 40);
  assert.equal(bounded, "- a: one\n- b: two\n(2 more omitted)");
});

test("the transcript keeps a floor of 20 000 chars when loaded topics fill the budget", () => {
  const loadedTopics = Array.from({ length: 12 }, (_, index) => ({
    name: `mem-any-loaded-${index}`,
    description: "When loading.",
    scope: "generic" as const,
    memories: [{ id: `r${index + 1}`, text: "m".repeat(4000) }],
  }));
  const turns = Array.from({ length: 15 }, (_, index) => ({ user: `user message ${index} ${"u".repeat(1900)}`, human: true, assistant: null }));
  const prompt = buildExtractPrompt({ repos: [], userMemory: "", topics: [], skills: [], loadedTopics, turns });
  const transcript = prompt.slice(prompt.indexOf("### User message 1"));
  assert.ok(transcript.length >= 19_000, `transcript is ${transcript.length} chars`);
  assert.ok(transcript.length <= 20_000 + 2000);
  assert.match(prompt, /user message 14 u/);
});
