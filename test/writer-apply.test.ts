import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig, type MemoryConfig } from "../src/config.ts";
import { loadProposalState, updateNote, updateProposalState } from "../src/proposal-state.ts";
import { readProposals } from "../src/proposals.ts";
import { runApply, skillCommitMessage, summarizeApply } from "../src/writer/apply.ts";
import { parseJob, writeJob, type ApplyJob, type ApplyProposal } from "../src/writer/job.ts";
import { runJob } from "../src/writer/main.ts";
import { buildApplyPrompt } from "../src/writer/prompts.ts";
import { readLastRun } from "../src/writer/runs.ts";
import { validateApply } from "../src/writer/validate.ts";

const SKILL = `---
name: react-code
description: Rules for writing React code
---

# React code

## Hooks

Keep hooks small.

## Context

Providers live next to the feature.
`;

const PROPOSALS = `## 2026-10-09 proposal:react-code

- Rule: Do not wrap a provider value in useMemo when its inputs change on every render.
- Why: The memo never hits.
- Evidence: "if not we should avoid it."
- Session: s1

## 2026-10-09 proposal:react-code

- Rule: Return hook output as one object without destructuring.
- Why: The owner stays clear.
- Evidence: "keep output without destructuring"
- Session: s1

## 2026-10-09 proposal:git

- Rule: Rebase before pushing.
- Why: Linear history.
- Evidence: "rebase first"
- Session: s2
`;

interface Fixture {
  root: string;
  dotfiles: string;
  skillFile: string;
  config: MemoryConfig;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(dir: string, root: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", join(root, "no-hooks"));
}

function setup(): Fixture {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "psm-apply-")));
  const dotfiles = join(root, "dotfiles");
  const skillDir = join(dotfiles, "agents", "skills", "react-code");
  initRepo(dotfiles, root);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), SKILL);
  writeFileSync(join(dotfiles, "notes.md"), "seed\n");
  git(dotfiles, "add", "-A");
  git(dotfiles, "commit", "-qm", "seed");
  mkdirSync(join(root, "agent", "skills"), { recursive: true });
  symlinkSync(skillDir, join(root, "agent", "skills", "react-code"));
  const dir = join(root, "memory");
  initRepo(dir, root);
  writeFileSync(join(dir, "proposals.md"), PROPOSALS);
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  const config = resolveConfig(
    { memory: { dir, stateDir: join(root, "state") } },
    { env: { PI_CODING_AGENT_DIR: join(root, "agent") }, home: root },
  );
  return { root, dotfiles, skillFile: join(skillDir, "SKILL.md"), config };
}

function applyProposals(fixture: Fixture, comments: Record<string, string> = {}): ApplyProposal[] {
  return readProposals(fixture.config.dir)
    .filter((proposal) => proposal.skill === "react-code")
    .map((proposal, index) => ({
      id: proposal.id,
      skill: proposal.skill,
      rule: proposal.rule,
      why: proposal.why,
      evidence: proposal.evidence,
      comment: comments[index] ?? "",
    }));
}

function job(fixture: Fixture, proposals: ApplyProposal[]): ApplyJob {
  return {
    kind: "apply",
    config: fixture.config,
    sessionId: "sess-review",
    cwd: fixture.root,
    packageRoot: "",
    createdAt: "2026-10-10T09:00:00.000Z",
    proposals,
  };
}

const EDITED = SKILL.replace(
  "Keep hooks small.",
  "Keep hooks small. Return hook output as one object without destructuring.",
).replace(
  "Providers live next to the feature.",
  "Providers live next to the feature. Skip useMemo on a provider value whose inputs change every render.",
);

function answering(body: string, summary = "Put the hook rule under Hooks and the memo rule under Context.") {
  const prompts: string[] = [];
  return {
    prompts,
    model: async (prompt: string) => {
      prompts.push(prompt);
      return JSON.stringify({ body, summary });
    },
  };
}

test("applies the approved proposals in one local commit per skill and removes them from proposals.md", async () => {
  const fixture = setup();
  writeFileSync(join(fixture.dotfiles, "notes.md"), "user work in progress\n");
  const proposals = applyProposals(fixture, { 0: "put it under Context" });
  updateProposalState(fixture.config.stateDir, (state) => {
    for (const proposal of proposals) updateNote(state, proposal.id, { applyingSince: "2026-10-10T09:00:00.000Z", comment: "x" });
  });
  const { model, prompts } = answering(EDITED);
  const jobFile = writeJob(job(fixture, proposals));
  const record = await runJob(jobFile, { model, home: fixture.root });

  assert.equal(record.kind, "apply");
  assert.equal(record.outcome, "ok");
  assert.deepEqual(record.topics, ["react-code"]);
  assert.equal(record.summary, "applied 2 to react-code");
  assert.deepEqual(readLastRun(fixture.config.stateDir, "apply"), record);
  assert.equal(readLastRun(fixture.config.stateDir), null);

  assert.equal(prompts.length, 1);
  assert.match(prompts[0]!, /<<<SKILL\.md\n---\nname: react-code\n[\s\S]*Providers live next to the feature\.\nSKILL\.md>>>/);
  assert.match(prompts[0]!, /- Rule: Do not wrap a provider value in useMemo[\s\S]*- Comment: put it under Context/);
  assert.match(prompts[0]!, /- Rule: Return hook output[\s\S]*- Comment: \(none\)/);

  assert.equal(readFileSync(fixture.skillFile, "utf8"), EDITED);
  assert.equal(git(fixture.dotfiles, "log", "--format=%s").trim().split("\n")[0], "react-code: apply memory proposals");
  assert.equal(git(fixture.dotfiles, "show", "--name-only", "--format=", "HEAD").trim(), "agents/skills/react-code/SKILL.md");
  const body = git(fixture.dotfiles, "log", "-1", "--format=%b");
  assert.match(body, /Do not wrap a provider value in useMemo when its inputs change on every render\. Review comment: put it under Context\./);
  assert.match(body, /Return hook output as one object without destructuring\.\n/);
  assert.equal(git(fixture.dotfiles, "status", "--porcelain").trim(), "M notes.md");
  assert.equal(git(fixture.dotfiles, "remote").trim(), "");

  assert.deepEqual(readProposals(fixture.config.dir).map((proposal) => proposal.skill), ["git"]);
  assert.equal(git(fixture.config.dir, "log", "-1", "--format=%s").trim(), "memory: remove applied proposals for react-code");
  assert.equal(git(fixture.config.dir, "status", "--porcelain"), "");
  assert.deepEqual(loadProposalState(fixture.config.stateDir).proposals, {});
});

test("skips a skill with uncommitted changes or off main, keeps its proposals and records why", async () => {
  for (const [label, prepare, reason] of [
    ["dirty", (fixture: Fixture) => writeFileSync(fixture.skillFile, `${SKILL}\nDraft.\n`), /SKILL\.md has uncommitted changes/],
    ["branch", (fixture: Fixture) => git(fixture.dotfiles, "checkout", "-qb", "feature"), /on branch feature, not main or master/],
  ] as const) {
    const fixture = setup();
    prepare(fixture);
    const before = readFileSync(fixture.skillFile, "utf8");
    const proposals = applyProposals(fixture);
    const { model, prompts } = answering(EDITED);
    const result = await runApply(job(fixture, proposals), { model, home: fixture.root });
    assert.equal(result.outcome, "skipped", label);
    assert.equal(result.summary, "2 skipped", label);
    assert.equal(prompts.length, 0, label);
    assert.equal(readFileSync(fixture.skillFile, "utf8"), before, label);
    assert.equal(git(fixture.dotfiles, "rev-list", "--count", "HEAD").trim(), "1", label);
    assert.equal(readProposals(fixture.config.dir).length, 3, label);
    const notes = loadProposalState(fixture.config.stateDir).proposals;
    for (const proposal of proposals) assert.match(notes[proposal.id]!.lastError!, reason, label);
  }
});

test("a rejected model answer leaves the skill and proposals alone and fails the run", async () => {
  const fixture = setup();
  const proposals = applyProposals(fixture);
  const { model } = answering(EDITED.replace("name: react-code", "name: react"));
  const jobFile = writeJob(job(fixture, proposals));
  const record = await runJob(jobFile, { model, home: fixture.root });
  assert.equal(record.outcome, "failed");
  assert.equal(record.summary, "2 failed");
  assert.match(record.error!, /react-code: model answer rejected: frontmatter name changed from react-code to react/);
  assert.equal(readFileSync(fixture.skillFile, "utf8"), SKILL);
  assert.equal(readProposals(fixture.config.dir).length, 3);
  assert.match(loadProposalState(fixture.config.stateDir).proposals[proposals[0]!.id]!.lastError!, /^failed: model answer rejected/);
});

test("an unknown skill fails, and a proposal no longer in proposals.md is dropped", async () => {
  const fixture = setup();
  const [git1] = readProposals(fixture.config.dir).filter((proposal) => proposal.skill === "git");
  const gone: ApplyProposal = { id: "deadbeef00", skill: "react-code", rule: "Gone.", why: "", evidence: "", comment: "" };
  const { model, prompts } = answering(EDITED);
  const result = await runApply(
    job(fixture, [{ ...git1!, comment: "" }, gone]),
    { model, home: fixture.root },
  );
  assert.equal(prompts.length, 0);
  assert.deepEqual(result.skills, [{ skill: "git", status: "failed", ids: [git1!.id], reason: "skill git is not in the skill index" }]);
});

test("validateApply checks frontmatter, name, emptiness and growth", () => {
  const context = { name: "react-code", original: SKILL, addedChars: 100 };
  assert.deepEqual(validateApply({ body: EDITED, summary: " Done. " }, context), { ok: true, body: EDITED, summary: "Done." });
  assert.equal(validateApply({ body: EDITED.trimEnd() }, context).ok, true);
  const error = (data: unknown) => {
    const result = validateApply(data, context);
    return result.ok ? "ok" : result.error;
  };
  assert.equal(error([]), "answer is not a JSON object");
  assert.equal(error({ body: "  " }), "body is missing or empty");
  assert.equal(error({ body: "# React code\n\nNo frontmatter at all, but long enough to pass the shrink guard........................................................................................................................................................." }), "frontmatter does not parse");
  assert.equal(error({ body: EDITED.replace("name: react-code", "name: other") }), "frontmatter name changed from react-code to other");
  assert.equal(error({ body: "---\nname: react-code\n---\n" }), "skill body is empty");
  assert.match(error({ body: `${EDITED}\n${"x".repeat(5000)}\n` }), /^body grew to \d+ chars, more than \d+$/);
  assert.match(error({ body: "---\nname: react-code\ndescription: d\n---\n\nShort.\n" }), /^body shrank to/);
  assert.equal(error({ body: SKILL }), "body is unchanged");
});

test("the apply job round-trips through its job file and the summary counts skips and failures", () => {
  const fixture = setup();
  const proposals = applyProposals(fixture, { 1: "only the first sentence" });
  const parsed = parseJob(readFileSync(writeJob(job(fixture, proposals)), "utf8"));
  assert.equal(parsed.kind, "apply");
  assert.deepEqual(parsed.kind === "apply" ? parsed.proposals : null, proposals);
  assert.equal(
    summarizeApply([
      { skill: "react-code", status: "applied", ids: ["a", "b"], summary: "" },
      { skill: "git", status: "applied", ids: ["c"], summary: "" },
      { skill: "nightshift", status: "skipped", ids: ["d"], reason: "dirty" },
      { skill: "mux", status: "failed", ids: ["e", "f"], reason: "bad" },
    ]),
    "applied 2 to react-code, 1 to git · 1 skipped · 2 failed",
  );
  assert.equal(
    skillCommitMessage("git", [{ id: "c", skill: "git", rule: "Rebase before pushing", why: "", evidence: "", comment: "" }], ""),
    "git: apply memory proposal\n\nRebase before pushing.\n",
  );
  assert.match(buildApplyPrompt({ skillName: "x", skill: "{notAPlaceholder}\n", proposals: [] }), /\{notAPlaceholder\}\nSKILL\.md>>>/);
});
