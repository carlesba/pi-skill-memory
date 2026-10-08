import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig, type MemoryConfig } from "../src/config.ts";
import { emptyLedger, isoDate, loadLedger, saveLedger, type Ledger } from "../src/ledger.ts";
import { parseTopic, serializeTopic, topicLedgerPath, topicSkillPath, type Memory, type Scope } from "../src/topics.ts";
import { appendUsageEvent } from "../src/usage.ts";
import { writeJob, type WriterJob } from "../src/writer/job.ts";
import { runJob } from "../src/writer/main.ts";
import type { ModelRunner } from "../src/writer/model.ts";
import { runPipeline } from "../src/writer/pipeline.ts";
import { readLastRun } from "../src/writer/runs.ts";
import { fakeResolver, writeFixtureSession } from "./writer-helpers.ts";

const NOW = new Date("2025-03-01T12:00:00.000Z");

interface Fixture {
  root: string;
  dir: string;
  cwd: string;
  config: MemoryConfig;
  sessionFile: string;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initGit(dir: string, root: string): void {
  mkdirSync(join(root, "no-hooks"), { recursive: true });
  git(dir, "init", "-q");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", join(root, "no-hooks"));
}

function writeTopic(dir: string, name: string, scope: Scope, description: string, memories: Memory[], ledger: Ledger): void {
  mkdirSync(join(dir, "memory-skills", name), { recursive: true });
  writeFileSync(topicSkillPath(dir, name), serializeTopic({ name, description, scope, updated: "2025-01-01", memories }));
  saveLedger(topicLedgerPath(dir, name), ledger);
}

function setup(memory: Record<string, unknown> = {}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "psm-writer-"));
  const dir = join(root, "memory");
  const cwd = join(root, "work", "app");
  mkdirSync(cwd, { recursive: true });
  mkdirSync(join(root, "agent", "skills", "git"), { recursive: true });
  writeFileSync(join(root, "agent", "skills", "git", "SKILL.md"), "---\nname: git\ndescription: Git workflow rules\n---\nBody\n");
  const config = resolveConfig(
    { memory: { dir, stateDir: join(root, "state"), ...memory } },
    { env: { PI_CODING_AGENT_DIR: join(root, "agent") }, home: root },
  );
  const testingLedger = emptyLedger();
  testingLedger.nextId = 3;
  testingLedger.memories.r1 = { source: "old", learned: "2025-01-01", votes: [] };
  testingLedger.memories.r2 = { source: "old", learned: "2025-01-01", votes: [] };
  writeTopic(
    dir,
    "mem-any-testing",
    "generic",
    "When writing tests in any repo.",
    [
      { id: "r1", text: "Use node:test for unit tests." },
      { id: "r2", text: "Keep snapshot files next to the test." },
    ],
    testingLedger,
  );
  const oldLedger = emptyLedger("2024-01-01T00:00:00.000Z");
  oldLedger.nextId = 2;
  oldLedger.memories.r1 = { source: "old", learned: "2024-01-01", votes: [] };
  writeTopic(dir, "mem-any-old-notes", "generic", "Shell alias conventions.", [{ id: "r1", text: "Prefer short aliases." }], oldLedger);
  const sessionFile = writeFixtureSession(join(root, "session.jsonl"), { cwd, dir });
  return { root, dir, cwd, config, sessionFile };
}

function job(fixture: Fixture, overrides: Partial<WriterJob> = {}): WriterJob {
  return {
    config: fixture.config,
    sessionFile: fixture.sessionFile,
    sessionId: "sess-1",
    cwd: fixture.cwd,
    packageRoot: "",
    force: false,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function scriptedModel(script: { extract: unknown; merges: Record<string, unknown>; user?: unknown }) {
  const prompts: string[] = [];
  const model: ModelRunner = async (prompt) => {
    prompts.push(prompt);
    if (prompt.startsWith("# Extract lessons")) return `\`\`\`json\n${JSON.stringify(script.extract)}\n\`\`\``;
    if (prompt.startsWith("# Rewrite the user memory")) return JSON.stringify(script.user);
    const name = /^- Name: (\S+)$/m.exec(prompt)?.[1] ?? "";
    if (!(name in script.merges)) throw new Error(`unexpected merge for ${name}`);
    return JSON.stringify(script.merges[name]);
  };
  return { model, prompts };
}

test("end to end: creates a topic with minted ids, applies votes, sweeps, removes stale topics and commits", async () => {
  const fixture = setup();
  initGit(fixture.dir, fixture.root);
  git(fixture.dir, "add", "-A");
  git(fixture.dir, "commit", "-qm", "seed");
  appendUsageEvent(fixture.config.stateDir, { ts: "2025-03-01T10:00:02.000Z", kind: "loaded", topic: "mem-any-testing", session: "sess-1" });
  const { model, prompts } = scriptedModel({
    extract: {
      candidates: [
        { rule: "Use node:test, never vitest.", why: "The user corrected vitest.", evidence: "No, I said node:test.", scope: "generic", target: "mem-any-testing" },
        { rule: "Name component files in PascalCase.", why: "Matches the export.", evidence: "use PascalCase", scope: "generic", target: "new:react-components" },
        { rule: "Never add vitest.", why: "Zero dev deps.", evidence: "never vitest, in every repo", scope: "generic", target: "user.md" },
        { rule: "Rebase before pushing.", why: "Linear history.", evidence: "rebase first", scope: "generic", target: "proposal:git" },
      ],
      votes: [
        { topic: "mem-any-testing", id: "r1", kind: "confirmed" },
        { topic: "mem-any-testing", id: "r2", kind: "retracted" },
        { topic: "mem-any-testing", id: "r99", kind: "applied" },
      ],
    },
    merges: {
      "mem-any-testing": {
        description: "When writing or running tests in any repo.",
        body: "Use node:test for unit tests, never vitest. ^r1",
        removed: [{ id: "r1", why: "restated with the vitest correction" }],
        split: null,
      },
      "mem-any-react-components": {
        description: "When writing React components in any repo.",
        body: "Name component files in PascalCase. ^new\n\nExport one component per file. ^new",
        removed: [],
        split: null,
      },
    },
    user: { body: "Never add vitest; use node:test.", removed: [] },
  });
  const jobFile = writeJob(job(fixture));
  const record = await runJob(jobFile, { model, now: () => NOW, resolver: fakeResolver({ [fixture.cwd]: "acme/app" }), home: fixture.root });

  assert.equal(record.outcome, "ok", record.error);
  assert.deepEqual(record.topics, ["mem-any-old-notes", "mem-any-react-components", "mem-any-testing"]);
  assert.deepEqual(readLastRun(fixture.config.stateDir), record);
  assert.equal(existsSync(jobFile), false);
  assert.equal(existsSync(join(fixture.dir, ".writer.lock")), false);

  const extractPrompt = prompts[0]!;
  assert.match(extractPrompt, /- acme\/app/);
  assert.match(extractPrompt, /- r2: Keep snapshot files next to the test\./);
  assert.match(extractPrompt, /- git: Git workflow rules/);
  const testingPrompt = prompts.find((prompt) => prompt.includes("- Name: mem-any-testing"))!;
  assert.doesNotMatch(testingPrompt, /\^r2/);

  const created = parseTopic(readFileSync(topicSkillPath(fixture.dir, "mem-any-react-components"), "utf8"))!;
  assert.equal(created.scope, "generic");
  assert.equal(created.updated, isoDate(NOW));
  assert.equal(created.description, "When writing React components in any repo.");
  assert.deepEqual(created.memories.map((memory) => memory.id), ["r1", "r2"]);
  const createdLedger = loadLedger(topicLedgerPath(fixture.dir, "mem-any-react-components"));
  assert.equal(createdLedger.nextId, 3);
  assert.equal(createdLedger.topic.created, NOW.toISOString());
  assert.deepEqual(createdLedger.memories.r1, { source: "sess-1", learned: "2025-03-01", votes: [] });

  const testing = parseTopic(readFileSync(topicSkillPath(fixture.dir, "mem-any-testing"), "utf8"))!;
  assert.deepEqual(testing.memories, [{ id: "r1", text: "Use node:test for unit tests, never vitest." }]);
  const testingLedger = loadLedger(topicLedgerPath(fixture.dir, "mem-any-testing"));
  assert.deepEqual(Object.keys(testingLedger.memories), ["r1"]);
  assert.deepEqual(testingLedger.memories.r1!.votes.map((vote) => vote.kind), ["confirmed"]);
  assert.deepEqual(testingLedger.topic.votes.map((vote) => vote.kind), ["loaded"]);
  assert.equal(testingLedger.nextId, 3);

  assert.equal(existsSync(join(fixture.dir, "memory-skills", "mem-any-old-notes")), false);
  assert.equal(existsSync(join(fixture.config.stateDir, "usage.jsonl")), false);
  assert.equal(readFileSync(join(fixture.dir, "user.md"), "utf8"), "Never add vitest; use node:test.\n");
  assert.match(readFileSync(join(fixture.dir, "proposals.md"), "utf8"), /^## 2025-03-01 proposal:git\n\n- Rule: Rebase before pushing\./);
  assert.match(readFileSync(join(fixture.config.stateDir, "writer.log"), "utf8"), /dropped vote on unknown memory mem-any-testing#r99/);

  const message = git(fixture.dir, "log", "-1", "--format=%B");
  assert.match(message, /^memory: update mem-any-old-notes, mem-any-react-components, mem-any-testing, user\.md/);
  assert.match(message, /- mem-any-testing r2: retracted by the user/);
  assert.match(message, /- mem-any-testing r1: restated with the vitest correction/);
  assert.match(message, /- mem-any-old-notes: stale, no loaded vote in 60 days/);
  assert.match(message, /- git/);
  assert.equal(git(fixture.dir, "status", "--porcelain"), "");
  assert.doesNotMatch(git(fixture.dir, "ls-files"), /writer\.lock/);
});

test("a rejected pass 2 leaves the topic untouched and the run records it", async () => {
  const fixture = setup();
  const before = readFileSync(topicSkillPath(fixture.dir, "mem-any-testing"), "utf8");
  const { model } = scriptedModel({
    extract: {
      candidates: [{ rule: "Use node:test.", why: "Zero deps.", evidence: "use node:test", scope: "generic", target: "mem-any-testing" }],
      votes: [],
    },
    merges: { "mem-any-testing": { description: "When testing.", body: "Bogus. ^r7", removed: [], split: null } },
  });
  const result = await runPipeline(job(fixture), { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.equal(result.outcome, "ok");
  assert.match(result.rejected[0]!, /mem-any-testing: unknown memory id \^r7/);
  assert.equal(readFileSync(topicSkillPath(fixture.dir, "mem-any-testing"), "utf8"), before);
  assert.equal(result.committed, false);
});

test("a pass 2 or user.md answer that silently drops memories is rejected and changes nothing", async () => {
  const fixture = setup({ staleTopicDays: 100000 });
  const userPath = join(fixture.dir, "user.md");
  writeFileSync(userPath, "Be terse.\n");
  const before = readFileSync(topicSkillPath(fixture.dir, "mem-any-testing"), "utf8");
  const { model } = scriptedModel({
    extract: {
      candidates: [
        { rule: "Use node:test.", why: "Zero deps.", evidence: "use node:test", scope: "generic", target: "mem-any-testing" },
        { rule: "Never add vitest.", why: "Zero dev deps.", evidence: "never vitest, in every repo", scope: "generic", target: "user.md" },
      ],
      votes: [],
    },
    merges: { "mem-any-testing": { description: "When testing.", body: "", removed: [{ id: "r1", why: "outdated" }], split: null } },
    user: { body: "", removed: [] },
  });
  const result = await runPipeline(job(fixture), { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.match(result.rejected.join("\n"), /mem-any-testing: memories dropped without a removed entry: \^r2/);
  assert.match(result.rejected.join("\n"), /user\.md: body is empty but user\.md is not/);
  assert.equal(readFileSync(topicSkillPath(fixture.dir, "mem-any-testing"), "utf8"), before);
  assert.equal(readFileSync(userPath, "utf8"), "Be terse.\n");
});

test("a failed run keeps its job file so a queue can retry it", async () => {
  const fixture = setup();
  const jobFile = writeJob(job(fixture));
  const model: ModelRunner = async () => "not json";
  const record = await runJob(jobFile, { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.equal(record.outcome, "failed");
  assert.equal(existsSync(jobFile), true);
  assert.equal(existsSync(join(fixture.dir, ".writer.lock")), false);
});

test("a new topic at the scope cap goes to the closest existing topic", async () => {
  const fixture = setup({ maxGenericTopics: 2, staleTopicDays: 100000 });
  const { model, prompts } = scriptedModel({
    extract: {
      candidates: [
        { rule: "Run tests with the spec reporter.", why: "Readable test output.", evidence: "use the spec reporter", scope: "generic", target: "new:test-output" },
      ],
      votes: [],
    },
    merges: {
      "mem-any-testing": {
        description: "When writing tests in any repo.",
        body: "Use node:test for unit tests. ^r1\n\nKeep snapshot files next to the test. ^r2\n\nRun tests with the spec reporter. ^new",
        removed: [],
        split: null,
      },
    },
  });
  const result = await runPipeline(job(fixture), { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.equal(result.outcome, "ok", result.error);
  assert.deepEqual(result.topics, ["mem-any-testing"]);
  assert.ok(prompts.some((prompt) => prompt.includes("- Name: mem-any-testing") && prompt.includes("spec reporter")));
  assert.equal(existsSync(join(fixture.dir, "memory-skills", "mem-any-test-output")), false);
  const testing = parseTopic(readFileSync(topicSkillPath(fixture.dir, "mem-any-testing"), "utf8"))!;
  assert.deepEqual(testing.memories.map((memory) => memory.id), ["r1", "r2", "r3"]);
});

test("evicts the lowest-weight unprotected memory past maxMemoriesPerTopic", async () => {
  const fixture = setup({ maxMemoriesPerTopic: 2, staleTopicDays: 100000 });
  const ledgerPath = topicLedgerPath(fixture.dir, "mem-any-testing");
  const ledger = loadLedger(ledgerPath);
  ledger.memories.r1!.votes.push({ kind: "applied", ts: "2025-02-01T00:00:00.000Z" });
  saveLedger(ledgerPath, ledger);
  const { model } = scriptedModel({
    extract: {
      candidates: [{ rule: "Name tests after behaviour.", why: "Readable.", evidence: "name them by behaviour", scope: "generic", target: "mem-any-testing" }],
      votes: [],
    },
    merges: {
      "mem-any-testing": {
        description: "When writing tests in any repo.",
        body: "Use node:test for unit tests. ^r1\n\nKeep snapshot files next to the test. ^r2\n\nName tests after behaviour. ^new",
        removed: [],
        split: null,
      },
    },
  });
  const result = await runPipeline(job(fixture), { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.equal(result.outcome, "ok", result.error);
  const testing = parseTopic(readFileSync(topicSkillPath(fixture.dir, "mem-any-testing"), "utf8"))!;
  assert.deepEqual(testing.memories.map((memory) => memory.id), ["r1", "r3"]);
  assert.deepEqual(Object.keys(loadLedger(ledgerPath).memories).sort(), ["r1", "r3"]);
});

test("skips sessions with fewer user messages than minUserMessages unless forced", async () => {
  const fixture = setup({ minUserMessages: 5 });
  let called = false;
  const model: ModelRunner = async () => {
    called = true;
    return '{"candidates": [], "votes": []}';
  };
  const skipped = await runPipeline(job(fixture), { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.equal(skipped.outcome, "skipped");
  assert.equal(called, false);
  const forced = await runPipeline(job(fixture, { force: true }), { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.equal(called, true);
  assert.equal(forced.outcome, "ok");
  assert.deepEqual(forced.topics, ["mem-any-old-notes"]);
});

test("a stale topic with a similar neighbour is merged into it through pass 2", async () => {
  const fixture = setup();
  const shellLedger = emptyLedger("2025-02-20T00:00:00.000Z");
  writeTopic(fixture.dir, "mem-any-shell", "generic", "When writing shell aliases and scripts.", [], shellLedger);
  const { model, prompts } = scriptedModel({
    extract: { candidates: [], votes: [] },
    merges: {
      "mem-any-shell": {
        description: "When writing shell aliases and scripts.",
        body: "Prefer short aliases. ^new",
        removed: [],
        split: null,
      },
    },
  });
  const result = await runPipeline(job(fixture), { model, now: () => NOW, resolver: fakeResolver({}), home: fixture.root });
  assert.equal(result.outcome, "ok", result.error);
  assert.deepEqual(result.topics, ["mem-any-old-notes", "mem-any-shell"]);
  assert.match(prompts.find((prompt) => prompt.includes("- Name: mem-any-shell"))!, /Prefer short aliases\. Why: carried over from stale topic mem-any-old-notes/);
  assert.equal(existsSync(join(fixture.dir, "memory-skills", "mem-any-old-notes")), false);
  const shell = parseTopic(readFileSync(topicSkillPath(fixture.dir, "mem-any-shell"), "utf8"))!;
  assert.deepEqual(shell.memories, [{ id: "r1", text: "Prefer short aliases." }]);
});
