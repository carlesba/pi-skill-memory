import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  discoverSkillPaths,
  listTopics,
  memoryIds,
  mintTopicName,
  parseScope,
  parseTopic,
  scopeSlug,
  serializeTopic,
  slugify,
  topicSkillPath,
  type Scope,
  type TopicFile,
} from "../src/topics.ts";

const sample: TopicFile = {
  name: "mem-apollo-state",
  description: 'When changing state management in preply/apollo: "stores"',
  scope: "repo:preply/apollo",
  updated: "2025-03-01",
  memories: [
    { id: "r1", text: "Prefer zustand over context for shared state, because re-renders." },
    { id: "r7", text: "Keep selectors next to the store.\nThey are imported by tests." },
  ],
};

test("serializes and parses a topic skill round-trip", () => {
  const raw = serializeTopic(sample);
  assert.match(raw, /^---\nname: mem-apollo-state\n/);
  assert.match(raw, /\^r1\n\nKeep selectors/);
  assert.deepEqual(parseTopic(raw), sample);
  assert.deepEqual(memoryIds(raw.slice(raw.indexOf("---\n\n") + 5)), ["r1", "r7"]);
});

test("parses paragraphs with new markers and paragraphs without ids", () => {
  const parsed = parseTopic(
    "---\nname: mem-any-x\ndescription: d\nmetadata:\n  scope: generic\n  updated: 2025-01-01\n---\n\nOne ^new\n\nTwo without id\n",
  );
  assert.deepEqual(parsed?.memories, [
    { id: "new", text: "One" },
    { id: null, text: "Two without id" },
  ]);
});

test("rejects topics without description or valid scope", () => {
  assert.equal(parseTopic("---\nname: a\nmetadata:\n  scope: generic\n---\n"), null);
  assert.equal(parseTopic("---\nname: a\ndescription: d\nmetadata:\n  scope: repo:apollo\n---\n"), null);
  assert.equal(parseScope("repo:Preply/Apollo"), "repo:preply/apollo");
  assert.equal(parseScope("repo:group/sub/project"), "repo:group/sub/project");
  assert.equal(parseScope("global"), null);
});

function writeTopic(dir: string, topic: TopicFile) {
  mkdirSync(join(dir, "memory-skills", topic.name), { recursive: true });
  writeFileSync(topicSkillPath(dir, topic.name), serializeTopic(topic));
}

function topic(name: string, scope: Scope): TopicFile {
  return { name, description: `About ${name}`, scope, updated: "2025-01-01", memories: [{ id: "r1", text: "x" }] };
}

test("resources_discover scoping lists generic topics and topics of the cwd repo only", () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-topics-"));
  writeTopic(dir, topic("mem-any-react", "generic"));
  writeTopic(dir, topic("mem-apollo-state", "repo:preply/apollo"));
  writeTopic(dir, topic("mem-hermes-api", "repo:preply/hermes"));
  mkdirSync(join(dir, "memory-skills", "broken"), { recursive: true });
  writeFileSync(join(dir, "memory-skills", "broken", "SKILL.md"), "not a skill");
  const topics = listTopics(dir);
  assert.deepEqual(topics.map((entry) => entry.name), ["mem-any-react", "mem-apollo-state", "mem-hermes-api"]);
  assert.deepEqual(discoverSkillPaths(topics, "preply/apollo"), [
    topicSkillPath(dir, "mem-any-react"),
    topicSkillPath(dir, "mem-apollo-state"),
  ]);
  assert.deepEqual(discoverSkillPaths(topics, "Preply/Hermes"), [
    topicSkillPath(dir, "mem-any-react"),
    topicSkillPath(dir, "mem-hermes-api"),
  ]);
  assert.deepEqual(discoverSkillPaths(topics, null), [topicSkillPath(dir, "mem-any-react")]);
  assert.deepEqual(listTopics(join(dir, "missing")), []);
});

test("slugify keeps only lowercase alphanumerics and single hyphens", () => {
  assert.equal(slugify("  React Components!! (v2) "), "react-components-v2");
  assert.equal(slugify("a--b__c"), "a-b-c");
});

test("mints names from scope slug and topic, using owner-name when another repo owns the short slug", () => {
  assert.equal(mintTopicName("generic", "React components", []), "mem-any-react-components");
  assert.equal(mintTopicName("repo:preply/apollo", "state", []), "mem-apollo-state");
  const existing = [{ name: "mem-apollo-state", scope: "repo:preply/apollo" as Scope }];
  assert.equal(scopeSlug("repo:nasa/apollo", existing), "nasa-apollo");
  assert.equal(mintTopicName("repo:nasa/apollo", "state", existing), "mem-nasa-apollo-state");
  assert.equal(mintTopicName("repo:preply/apollo", "routing", existing), "mem-apollo-routing");
  const withLong = [...existing, { name: "mem-nasa-apollo-state", scope: "repo:nasa/apollo" as Scope }];
  assert.equal(scopeSlug("repo:nasa/apollo", withLong), "nasa-apollo");
  assert.equal(scopeSlug("repo:group/sub/any", []), "group-sub-any");
});

test("minted names are unique and at most 64 chars", () => {
  const existing = [{ name: "mem-apollo-state", scope: "repo:preply/apollo" as Scope }];
  assert.equal(mintTopicName("repo:preply/apollo", "state", existing), "mem-apollo-state-2");
  const long = mintTopicName("generic", "x".repeat(100), []);
  assert.equal(long.length, 64);
  assert.match(long, /^[a-z0-9-]+$/);
  const longTaken = mintTopicName("generic", "x".repeat(100), [{ name: long, scope: "generic" }]);
  assert.equal(longTaken.length, 64);
  assert.match(longTaken, /-2$/);
});
