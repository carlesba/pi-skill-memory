import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { ConfinementError, confinedPath, confinedTopicPath } from "../src/writer/confine.ts";
import { validateExtract, validateMerge, validateUserMerge, type ExtractContext } from "../src/writer/validate.ts";

const context: ExtractContext = {
  topicNames: new Set(["mem-any-testing"]),
  skillNames: new Set(["git"]),
  memoryIdsOf: (topic) => (topic === "mem-any-testing" ? new Set(["r1", "r2"]) : null),
};

function candidate(overrides: Record<string, unknown> = {}) {
  return { rule: "Use node:test.", why: "No deps.", evidence: "use node:test", scope: "generic", target: "mem-any-testing", ...overrides };
}

test("pass 1 accepts every target form and drops votes on unknown ids", () => {
  const result = validateExtract(
    {
      candidates: [
        candidate(),
        candidate({ target: "user.md" }),
        candidate({ target: "new:react-components", scope: "repo:Acme/App" }),
        candidate({ target: "proposal:git" }),
      ],
      votes: [
        { topic: "mem-any-testing", id: "r1", kind: "applied" },
        { topic: "mem-any-testing", id: "r9", kind: "confirmed" },
        { topic: "mem-unknown", id: "r1", kind: "applied" },
      ],
    },
    context,
  );
  assert.ok(result.ok);
  assert.deepEqual(
    result.candidates.map((entry) => entry.target),
    [{ kind: "topic", name: "mem-any-testing" }, { kind: "user" }, { kind: "new", slug: "react-components" }, { kind: "proposal", skill: "git" }],
  );
  assert.equal(result.candidates[2]!.scope, "repo:acme/app");
  assert.deepEqual(result.votes, [{ topic: "mem-any-testing", id: "r1", kind: "applied" }]);
  assert.deepEqual(result.dropped, ["mem-any-testing#r9", "mem-unknown#r1"]);
  assert.ok(validateExtract({}, context).ok);
});

test("pass 1 rejects oversized or malformed output", () => {
  const cases: unknown[] = [
    [],
    { candidates: Array.from({ length: 21 }, () => candidate()) },
    { candidates: [candidate({ rule: "x".repeat(401) })] },
    { candidates: [candidate({ why: "x".repeat(301) })] },
    { candidates: [candidate({ evidence: Array.from({ length: 21 }, () => "w").join(" ") })] },
    { candidates: [candidate({ scope: "repo:acme" })] },
    { candidates: [candidate({ target: "mem-missing" })] },
    { candidates: [candidate({ target: "new:../escape" })] },
    { candidates: [candidate({ target: "proposal:unknown" })] },
    { votes: [{ topic: "mem-any-testing", id: "r1", kind: "liked" }] },
  ];
  for (const value of cases) assert.equal(validateExtract(value, context).ok, false, JSON.stringify(value).slice(0, 80));
});

test("pass 2 rejects unknown ids, oversized bodies, headings and untagged paragraphs", () => {
  const merge = (body: string, extra: Record<string, unknown> = {}) =>
    validateMerge({ description: "When writing tests in any repo.", body, removed: [], split: null, ...extra }, {
      knownIds: new Set(["r1", "r2"]),
      existingIds: ["r1", "r2"],
      maxCharsPerTopic: 200,
    });
  const accepted = merge("Use node:test. ^r1\n\nNever vitest. ^new", { removed: [{ id: "r2", why: "merged into r1" }] });
  assert.ok(accepted.ok);
  assert.deepEqual(accepted.memories, [{ id: "r1", text: "Use node:test." }, { id: "new", text: "Never vitest." }]);
  assert.deepEqual(accepted.removed, [{ id: "r2", why: "merged into r1" }]);
  assert.match((merge("Use it. ^r7") as { error: string }).error, /unknown memory id \^r7/);
  assert.match((merge(`${"x".repeat(200)} ^r1`) as { error: string }).error, /longer than 200/);
  assert.equal(merge("# Heading\n\nUse it. ^r1").ok, false);
  assert.equal(merge("Use it.").ok, false);
  assert.equal(merge("A. ^r1\n\nB. ^r1").ok, false);
  assert.equal(merge("A. ^r1", { description: "x".repeat(301) }).ok, false);
  assert.equal(merge("A. ^r1", { description: "" }).ok, false);
});

test("user.md mode takes ids like a topic and rejects unknown ids and unmarked paragraphs", () => {
  const user = (body: string, removed: { id: string; why: string }[] = []) =>
    validateUserMerge({ body, removed }, { knownIds: new Set(["r1", "r2"]), existingIds: ["r1", "r2"] });
  const accepted = user("Be terse. ^r1\n\nPrefer small PRs. ^new", [{ id: "r2", why: "merged into r1" }]);
  assert.ok(accepted.ok);
  assert.deepEqual(accepted.memories, [{ id: "r1", text: "Be terse." }, { id: "new", text: "Prefer small PRs." }]);
  assert.match((user("Be terse. ^r7\n\nA. ^r1\n\nB. ^r2") as { error: string }).error, /unknown memory id \^r7/);
  assert.match((user("Be terse.\n\nA. ^r1\n\nB. ^r2") as { error: string }).error, /does not end in \^r<N> or \^new/);
  assert.equal(user("A. ^r1\n\nA again. ^r1", [{ id: "r2", why: "merged" }]).ok, false);
  assert.equal(user("# Rules\n\nA. ^r1\n\nB. ^r2").ok, false);
  assert.ok(user(`${"x".repeat(5000)} ^r1\n\nB. ^r2`).ok);
});

test("pass 2 rejects dropping an existing memory that removed does not account for", () => {
  const merge = (body: string, removed: { id: string; why: string }[]) =>
    validateMerge({ description: "When writing tests in any repo.", body, removed, split: null }, {
      knownIds: new Set(["r1", "r2", "r3"]),
      existingIds: ["r1", "r2", "r3"],
      maxCharsPerTopic: 400,
    });
  const silent = merge("Use node:test. ^r1", [{ id: "r2", why: "merged into r1" }]);
  assert.equal(silent.ok, false);
  assert.match((silent as { error: string }).error, /\^r3/);
  assert.doesNotMatch((silent as { error: string }).error, /\^r2/);
  assert.equal(merge("", []).ok, false);
  assert.equal(merge("", [{ id: "r1", why: "outdated" }]).ok, false);
  const emptied = merge("", [
    { id: "r1", why: "retracted" },
    { id: "r2", why: "retracted" },
    { id: "r3", why: "retracted" },
  ]);
  assert.ok(emptied.ok);
  assert.deepEqual(emptied.memories, []);
  assert.ok(merge("Use node:test. ^r1\n\nA. ^r2\n\nB. ^r3", []).ok);
});

test("user.md mode rejects dropping an existing memory that removed does not account for", () => {
  const user = (body: string, removed: { id: string; why: string }[]) =>
    validateUserMerge({ body, removed }, { knownIds: new Set(["r1", "r2"]), existingIds: ["r1", "r2"] });
  assert.match((user("", []) as { error: string }).error, /dropped without a removed entry: \^r1, \^r2/);
  assert.match((user("Be brief. ^new", [{ id: "r1", why: "reworded" }]) as { error: string }).error, /\^r2/);
  assert.ok(user("", [{ id: "r1", why: "retracted" }, { id: "r2", why: "retracted" }]).ok);
  assert.ok(validateUserMerge({ body: "", removed: [] }, { knownIds: new Set(), existingIds: [] }).ok);
});

test("writes are confined to the memory dir, including through symlinks", () => {
  const root = mkdtempSync(join(tmpdir(), "psm-confine-"));
  const dir = join(root, "memory");
  const outside = join(root, "outside");
  mkdirSync(join(dir, "memory-skills"), { recursive: true });
  mkdirSync(outside);
  symlinkSync(outside, join(dir, "memory-skills", "mem-any-link"));
  assert.equal(confinedTopicPath(dir, "mem-any-testing", "SKILL.md"), join(dir, "memory-skills", "mem-any-testing", "SKILL.md"));
  assert.equal(confinedPath(dir, "user.md"), join(dir, "user.md"));
  assert.throws(() => confinedTopicPath(dir, "../outside"), ConfinementError);
  assert.throws(() => confinedTopicPath(dir, "mem-any-link", "SKILL.md"), ConfinementError);
  assert.throws(() => confinedPath(dir, "/etc/passwd"), ConfinementError);
  assert.throws(() => confinedPath(dir, "memory-skills/../../outside/x"), ConfinementError);
});
