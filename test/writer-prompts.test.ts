import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
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
    turns: [{ user: "hello", assistant: "hi" }],
  });
  assert.match(extract, /- acme\/app/);
  assert.match(extract, /At most 20 candidates/);
  assert.doesNotMatch(extract, /\{[a-zA-Z]+\}/);
  const merge = buildMergePrompt({
    name: "mem-any-testing",
    scope: "generic",
    description: "",
    memories: [{ id: "r1", text: "Use node:test.", weight: 1, learned: "2025-01-01" }],
    candidates: [{ rule: "Never vitest.", why: "Zero deps.", evidence: "never vitest" }],
    descriptionFlags: [],
    relatedTopics: [],
    maxCharsPerTopic: 4000,
    maxMemoriesPerTopic: 12,
  });
  assert.match(merge, /\^r1 \(weight 1\.00, learned 2025-01-01\): Use node:test\./);
  assert.doesNotMatch(merge, /\{[a-zA-Z]+\}/);
  const user = buildUserMergePrompt({ userMemory: "Be terse.", candidates: [], maxUserChars: 4000 });
  assert.match(user, /at most 4000 characters/);
  assert.doesNotMatch(user, /\{[a-zA-Z]+\}/);
});

test("bounds the transcript by dropping oldest assistant texts, then truncating oldest user messages", () => {
  const turns = [
    { user: "u1".repeat(50), assistant: "a1".repeat(50) },
    { user: "u2".repeat(50), assistant: "a2".repeat(50) },
  ];
  const full = renderTranscript(turns).length;
  const oneDropped = boundTurns(turns, full - 10);
  assert.equal(oneDropped[0]!.assistant, null);
  assert.notEqual(oneDropped[1]!.assistant, null);
  const tight = boundTurns(turns, renderTranscript([{ user: "u2".repeat(50), assistant: null }]).length + 60);
  assert.ok(tight.every((turn) => turn.assistant === null));
  assert.ok(renderTranscript(tight).length <= renderTranscript([{ user: "u2".repeat(50), assistant: null }]).length + 60);
  assert.equal(tight[tight.length - 1]!.user, "u2".repeat(50));
  const prompt = buildExtractPrompt(
    { repos: [], userMemory: "", topics: [], skills: [], loadedTopics: [], turns: [{ user: "x".repeat(70_000), assistant: null }] },
    "head {maxCandidates}{maxRuleChars}{maxWhyChars}{maxEvidenceWords}{repos}{userMemory}{topicIndex}{skillIndex}{loadedTopics}{transcript}",
  );
  assert.ok(prompt.length <= 60_000);
});
