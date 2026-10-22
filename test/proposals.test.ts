import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  failedApplies,
  isApplying,
  loadProposalState,
  markApplying,
  MAX_APPLY_ATTEMPTS,
  pendingProposals,
  retryableProposals,
  proposalStatePath,
  pruneProposalState,
  saveProposalState,
  snooze,
  snoozedProposals,
  updateNote,
  updateProposalState,
  type ProposalState,
} from "../src/proposal-state.ts";
import { proposalWidgetLine } from "../src/review.ts";
import { discardProposal, parseProposals, proposalId, readProposals, withoutProposals } from "../src/proposals.ts";
import { runGit } from "../src/writer/commit.ts";
import { lockPath } from "../src/writer/lock.ts";

const SAMPLE = `## 2026-10-09 proposal:nightshift

- Rule: Update the mission plan when a decision supersedes it.
- Why: Agents read whatever is written where they look.
- Evidence: "what we agreed here should prevail"
- Session: 01a11ef4-4f0b-7748-b89a-4d00172ef9e2

## 2026-10-09 proposal:react-code

- Rule: Do not wrap a context provider value in useMemo when its inputs change on every render.
- Why: The memo never hits.
- Evidence: "if not we should avoid it."
- Session: 01a11f4c-d3b5-7748-b89a-4d026033bf92

## 2026-10-10 proposal:react-code

- Rule: Return hook output as one object without destructuring.
- Why: The owner of each method stays clear.
- Evidence: "I rather keep output from functions without destructuring"
- Session: 01a11f4c-d3b5-7748-b89a-4d026033bf92
`;

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

function initRepo(dir: string): void {
  mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  git(dir, "config", "core.hooksPath", join(dir, ".no-hooks"));
}

test("parses every proposal with its fields and an id derived from skill, rule and session", () => {
  const proposals = parseProposals(SAMPLE);
  assert.equal(proposals.length, 3);
  assert.deepEqual(proposals[1], {
    id: proposalId(
      "react-code",
      "Do not wrap a context provider value in useMemo when its inputs change on every render.",
      "01a11f4c-d3b5-7748-b89a-4d026033bf92",
    ),
    date: "2026-10-09",
    skill: "react-code",
    rule: "Do not wrap a context provider value in useMemo when its inputs change on every render.",
    why: "The memo never hits.",
    evidence: "if not we should avoid it.",
    session: "01a11f4c-d3b5-7748-b89a-4d026033bf92",
  });
  assert.match(proposals[0]!.id, /^[0-9a-f]{10}$/);
  assert.equal(new Set(proposals.map((proposal) => proposal.id)).size, 3);
  assert.deepEqual(parseProposals(SAMPLE.replace(/\n/g, "\r\n")).map((proposal) => proposal.id), proposals.map((proposal) => proposal.id));
});

test("ids stay the same when unrelated entries move, and removing one keeps the others byte for byte", () => {
  const [first, second, third] = parseProposals(SAMPLE);
  const reordered = `${SAMPLE.trimEnd().split(/\n\n(?=## )/).reverse().join("\n\n")}\n`;
  assert.deepEqual(parseProposals(reordered).map((proposal) => proposal.id), [third!.id, second!.id, first!.id]);
  const remaining = withoutProposals(SAMPLE, [second!.id]);
  assert.equal(remaining, SAMPLE.replace(/## 2026-10-09 proposal:react-code\n[\s\S]*?\n\n(?=## )/, ""));
  assert.deepEqual(parseProposals(remaining).map((proposal) => proposal.id), [first!.id, third!.id]);
  assert.equal(withoutProposals(SAMPLE, [first!.id, second!.id, third!.id]), "");
});

test("snoozed and applying proposals leave the pending list until their time is up", () => {
  const proposals = parseProposals(SAMPLE);
  const now = new Date("2026-10-10T08:00:00.000Z");
  const state: ProposalState = { proposals: {} };
  snooze(state, proposals[0]!.id, now);
  updateNote(state, proposals[1]!.id, { applyingSince: now.toISOString() });
  assert.deepEqual(pendingProposals(proposals, state, now).map((proposal) => proposal.skill), ["react-code"]);
  assert.equal(pendingProposals(proposals, state, now)[0]!.id, proposals[2]!.id);
  assert.deepEqual(snoozedProposals(proposals, state, now).map((proposal) => proposal.id), [proposals[0]!.id]);
  const tomorrow = new Date(now.getTime() + 24 * 60 * 60_000 + 1);
  assert.equal(pendingProposals(proposals, state, tomorrow).length, 3);
  assert.equal(isApplying(state.proposals[proposals[1]!.id], tomorrow), false);
});

test("an approved proposal stays out of review until its apply fails in a way that needs the user", () => {
  const proposals = parseProposals(SAMPLE);
  const id = proposals[0]!.id;
  const approvedAt = new Date("2026-10-10T08:00:00.000Z");
  const later = new Date(approvedAt.getTime() + 3 * 60 * 60_000);
  const state: ProposalState = { proposals: {} };
  const ids = (list: { id: string }[]) => list.map((proposal) => proposal.id);

  markApplying(state, id, approvedAt, "user");
  assert.equal(ids(pendingProposals(proposals, state, approvedAt)).includes(id), false);
  assert.deepEqual(ids(retryableProposals(proposals, state, approvedAt)), []);
  assert.deepEqual(ids(retryableProposals(proposals, state, later)), [id], "a job that died is retried once its applying window ends");

  updateNote(state, id, { applyingSince: undefined, lastError: "skipped: SKILL.md changed while the model was working" });
  assert.equal(ids(pendingProposals(proposals, state, later)).includes(id), false);
  assert.deepEqual(ids(retryableProposals(proposals, state, later)), [id]);
  assert.deepEqual(failedApplies(proposals, state, later), []);

  updateNote(state, id, { needsUser: true, lastError: "failed: model run failed: no credentials" });
  assert.deepEqual(ids(retryableProposals(proposals, state, later)), []);
  assert.deepEqual(ids(failedApplies(proposals, state, later)), [id]);
  assert.equal(ids(pendingProposals(proposals, state, later)).includes(id), true);

  markApplying(state, id, later, "user");
  assert.deepEqual(state.proposals[id], { applyingSince: later.toISOString(), approvedAt: later.toISOString(), attempts: 1 });
});

test("automatic retries stop after the attempt limit and hand the proposal back to the user", () => {
  const proposals = parseProposals(SAMPLE);
  const id = proposals[0]!.id;
  const now = new Date("2026-10-10T08:00:00.000Z");
  const state: ProposalState = { proposals: {} };
  markApplying(state, id, now, "user");
  for (let attempt = 1; attempt < MAX_APPLY_ATTEMPTS; attempt++) {
    updateNote(state, id, { applyingSince: undefined, lastError: "failed: model answer rejected: body is unchanged" });
    assert.equal(retryableProposals(proposals, state, now).length, 1, `attempt ${attempt}`);
    markApplying(state, id, now, "retry");
  }
  updateNote(state, id, { applyingSince: undefined });
  assert.equal(state.proposals[id]!.attempts, MAX_APPLY_ATTEMPTS);
  assert.equal(state.proposals[id]!.lastError, "failed: model answer rejected: body is unchanged");
  assert.deepEqual(retryableProposals(proposals, state, now), []);
  assert.equal(failedApplies(proposals, state, now).length, 1);
});

test("the state file keeps the approval, attempt count and needs-user flag", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "psm-proposal-approval-"));
  const saved = updateProposalState(stateDir, (state) => {
    updateNote(state, "a", { approvedAt: "2026-10-10T08:00:00.000Z", attempts: 2, needsUser: true, lastError: "failed: x" });
  });
  assert.deepEqual(loadProposalState(stateDir), saved);
});

test("the state file round-trips comments, drops entries of removed proposals and survives garbage", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "psm-proposal-state-"));
  assert.deepEqual(loadProposalState(stateDir), { proposals: {} });
  writeFileSync(proposalStatePath(stateDir), "not json");
  assert.deepEqual(loadProposalState(stateDir), { proposals: {} });
  const saved = updateProposalState(stateDir, (state) => {
    updateNote(state, "a", { comment: "only the first sentence" });
    updateNote(state, "b", { comment: "gone" });
    updateNote(state, "c", { comment: "" });
  });
  assert.deepEqual(saved.proposals, { a: { comment: "only the first sentence" }, b: { comment: "gone" } });
  const loaded = loadProposalState(stateDir);
  assert.deepEqual(loaded, saved);
  assert.equal(pruneProposalState(loaded, ["a"]), true);
  assert.equal(pruneProposalState(loaded, ["a"]), false);
  saveProposalState(stateDir, loaded);
  assert.deepEqual(loadProposalState(stateDir).proposals, { a: { comment: "only the first sentence" } });
});

test("discard removes one entry under the writer lock and commits only proposals.md", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-discard-"));
  initRepo(dir);
  writeFileSync(join(dir, "proposals.md"), SAMPLE);
  writeFileSync(join(dir, "user.md"), "Seed. ^r1\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-qm", "seed");
  writeFileSync(join(dir, "user.md"), "Work in progress. ^r1\n");
  const [, target] = readProposals(dir);
  let sawLock = false;
  const result = await discardProposal(dir, target!, {
    autoCommit: true,
    git: (args, cwd) => {
      if (args[0] === "commit") sawLock = existsSync(lockPath(dir));
      return runGit(args, cwd);
    },
  });
  assert.deepEqual(result.removed, [target!.id]);
  assert.deepEqual(result.commit, { committed: true });
  assert.equal(sawLock, true);
  assert.equal(existsSync(lockPath(dir)), false);
  assert.deepEqual(readProposals(dir).map((proposal) => proposal.id).includes(target!.id), false);
  assert.equal(readProposals(dir).length, 2);
  assert.match(git(dir, "log", "-1", "--format=%B"), /^memory: discard proposal for react-code\n\nDo not wrap a context provider value/);
  assert.equal(git(dir, "show", "--name-only", "--format=", "HEAD").trim(), "proposals.md");
  assert.equal(git(dir, "status", "--porcelain").trim(), "M user.md");
  assert.equal(readFileSync(join(dir, "user.md"), "utf8"), "Work in progress. ^r1\n");
});

test("discard waits for a writer that holds the lock", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-discard-wait-"));
  writeFileSync(join(dir, "proposals.md"), SAMPLE);
  writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "writer" }));
  const [target] = readProposals(dir);
  let done = false;
  const pending = discardProposal(dir, target!, { autoCommit: false, lock: { pollMs: 5 } }).then((result) => {
    done = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(done, false);
  assert.equal(readProposals(dir).length, 3);
  writeFileSync(join(dir, "proposals.md"), `${SAMPLE}\n## 2026-10-11 proposal:git\n\n- Rule: Appended meanwhile.\n- Why: x\n- Evidence: "y"\n- Session: s\n`);
  execFileSync("rm", [lockPath(dir)]);
  const result = await pending;
  assert.deepEqual(result.removed, [target!.id]);
  assert.equal(result.commit, null);
  assert.deepEqual(readProposals(dir).map((proposal) => proposal.skill), ["react-code", "react-code", "git"]);
});

test("the startup widget says how many proposals failed to apply and need the user", () => {
  assert.equal(proposalWidgetLine(2, null, 1), "2 memory proposals (1 failed to apply and needs you) — /proposals");
  assert.equal(proposalWidgetLine(2, null), "2 memory proposals — /proposals");
});
