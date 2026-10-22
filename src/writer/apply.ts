import { chmodSync, readFileSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, relative } from "node:path";
import { parseFrontmatter } from "../frontmatter.ts";
import { updateNote, updateProposalState } from "../proposal-state.ts";
import { readProposals, removeProposals, writeFileAtomic } from "../proposals.ts";
import { readSkillIndex, skillIndexRoots } from "../skill-index.ts";
import { commitPaths, runGit, type GitExec } from "./commit.ts";
import type { ApplyJob, ApplyProposal } from "./job.ts";
import { withLock, type LockOptions } from "./lock.ts";
import { extractJson, type ModelRunner } from "./model.ts";
import { buildApplyPrompt, loadPrompt, PACKAGE_ROOT } from "./prompts.ts";
import type { RunOutcomeKind } from "./runs.ts";
import { validateApply } from "./validate.ts";

export const APPLY_BRANCHES = ["main", "master"];

export interface ApplyDeps {
  model: ModelRunner;
  git?: GitExec;
  log?: (line: string) => void;
  home?: string;
  lock?: LockOptions;
}

export interface SkillTarget {
  file: string;
  root: string;
  relativePath: string;
}

export type SkillOutcome =
  | { skill: string; status: "applied"; ids: string[]; summary: string }
  | { skill: string; status: "skipped" | "failed"; ids: string[]; reason: string; needsUser: boolean };

export interface ApplyRunResult {
  outcome: RunOutcomeKind;
  skills: SkillOutcome[];
  summary: string;
}

type Located = { ok: true; target: SkillTarget } | { ok: false; status: "skipped" | "failed"; reason: string };

const NEEDS_USER_RUNNER_ERROR = /no api key|no credentials|no models match|not authenticated|unauthori[sz]ed|expired|log ?in|forbidden|access denied/i;

export function runnerErrorNeedsUser(reason: string): boolean {
  return NEEDS_USER_RUNNER_ERROR.test(reason);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function sentence(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  return /[.!?]$/.test(collapsed) ? collapsed : `${collapsed}.`;
}

export function skillCommitMessage(skill: string, proposals: ApplyProposal[], summary: string): string {
  const subject = `${skill}: apply memory proposal${proposals.length === 1 ? "" : "s"}`;
  const paragraphs = proposals.map((proposal) => {
    const comment = proposal.comment.trim() === "" ? "" : ` Review comment: ${sentence(proposal.comment)}`;
    return `${sentence(proposal.rule)}${comment}`;
  });
  if (summary.trim() !== "") paragraphs.push(sentence(summary));
  return `${subject}\n\n${paragraphs.join("\n\n")}\n`;
}

export function dirtyReason(target: SkillTarget, git: GitExec): string | null {
  const status = git(["status", "--porcelain", "--untracked-files=all", "--", target.relativePath], target.root);
  if (status.status !== 0) return `git status failed: ${status.stderr.trim()}`;
  return status.stdout.trim() === "" ? null : "SKILL.md has uncommitted changes";
}

export function checkSkillRepo(file: string, git: GitExec = runGit): Located {
  const top = git(["rev-parse", "--show-toplevel"], dirname(file));
  if (top.status !== 0 || top.stdout.trim() === "") return { ok: false, status: "skipped", reason: `${file} is not in a git repository` };
  const root = realpathSync(top.stdout.trim());
  const target: SkillTarget = { file, root, relativePath: relative(root, file) };
  const head = git(["symbolic-ref", "--quiet", "--short", "HEAD"], root);
  const branch = head.status === 0 ? head.stdout.trim() : "";
  if (!APPLY_BRANCHES.includes(branch)) {
    return { ok: false, status: "skipped", reason: `the skill repository is on ${branch === "" ? "a detached HEAD" : `branch ${branch}`}, not main or master` };
  }
  const dirty = dirtyReason(target, git);
  if (dirty) return { ok: false, status: "skipped", reason: dirty };
  return { ok: true, target };
}

export function locateSkill(skill: string, roots: string[], memoryDir: string, git: GitExec = runGit): Located {
  const entry = readSkillIndex(roots, memoryDir).find((candidate) => candidate.name === skill);
  if (!entry) return { ok: false, status: "failed", reason: `skill ${skill} is not in the skill index` };
  let file: string;
  try {
    file = realpathSync(entry.path);
  } catch (error) {
    return { ok: false, status: "failed", reason: `cannot resolve ${entry.path}: ${errorMessage(error)}` };
  }
  return checkSkillRepo(file, git);
}

function writePreservingMode(path: string, content: string): void {
  const mode = statSync(path).mode & 0o777;
  writeFileAtomic(path, content);
  chmodSync(path, mode);
}

async function applySkill(
  skill: string,
  proposals: ApplyProposal[],
  located: Located,
  deps: { model: ModelRunner; git: GitExec; template: string },
): Promise<SkillOutcome> {
  const ids = proposals.map((proposal) => proposal.id);
  if (!located.ok) return { skill, status: located.status, ids, reason: located.reason, needsUser: true };
  const target = located.target;
  const original = readFileSync(target.file, "utf8");
  const name = parseFrontmatter(original)?.fields.name?.trim() ?? "";
  const prompt = buildApplyPrompt({ skillName: name || skill, skill: original, proposals }, deps.template);
  let answer: string;
  try {
    answer = await deps.model(prompt);
  } catch (error) {
    const reason = `model run failed: ${errorMessage(error)}`;
    return { skill, status: "failed", ids, reason, needsUser: runnerErrorNeedsUser(reason) };
  }
  let result: ReturnType<typeof validateApply>;
  try {
    result = validateApply(extractJson(answer), {
      name,
      original,
      addedChars: proposals.reduce((sum, proposal) => sum + proposal.rule.length + proposal.comment.length, 0),
    });
  } catch (error) {
    result = { ok: false, error: errorMessage(error) };
  }
  if (!result.ok) return { skill, status: "failed", ids, reason: `model answer rejected: ${result.error}`, needsUser: false };
  const dirty = dirtyReason(target, deps.git);
  if (dirty) return { skill, status: "skipped", ids, reason: dirty, needsUser: true };
  if (readFileSync(target.file, "utf8") !== original) {
    return { skill, status: "skipped", ids, reason: "SKILL.md changed while the model was working", needsUser: false };
  }
  writePreservingMode(target.file, result.body);
  const commit = commitPaths(target.root, [target.relativePath], skillCommitMessage(skill, proposals, result.summary), deps.git);
  if (!commit.committed) {
    writePreservingMode(target.file, original);
    return { skill, status: "failed", ids, reason: `commit failed, SKILL.md restored: ${commit.reason}`, needsUser: true };
  }
  return { skill, status: "applied", ids, summary: result.summary };
}

export function summarizeApply(skills: SkillOutcome[]): string {
  const applied = skills.filter((outcome) => outcome.status === "applied");
  const parts: string[] = [];
  if (applied.length > 0) parts.push(`applied ${applied.map((outcome) => `${outcome.ids.length} to ${outcome.skill}`).join(", ")}`);
  const count = (status: "skipped" | "failed") =>
    skills.filter((outcome) => outcome.status === status).reduce((sum, outcome) => sum + outcome.ids.length, 0);
  if (count("skipped") > 0) parts.push(`${count("skipped")} skipped`);
  if (count("failed") > 0) parts.push(`${count("failed")} failed`);
  return parts.length === 0 ? "nothing to apply" : parts.join(" · ");
}

function overallOutcome(skills: SkillOutcome[]): RunOutcomeKind {
  if (skills.some((outcome) => outcome.status === "applied")) return "ok";
  if (skills.some((outcome) => outcome.status === "failed")) return "failed";
  if (skills.length > 0) return "skipped";
  return "nothing";
}

function removalMessage(applied: SkillOutcome[]): string {
  const skills = applied.map((outcome) => outcome.skill);
  return `memory: remove applied proposals for ${skills.join(", ")}\n\n${applied
    .map((outcome) => `- ${outcome.skill}: ${outcome.ids.length} applied`)
    .join("\n")}\n`;
}

export async function runApply(job: ApplyJob, deps: ApplyDeps): Promise<ApplyRunResult> {
  const config = job.config;
  const git = deps.git ?? runGit;
  const log = deps.log ?? (() => undefined);
  const home = deps.home ?? homedir();
  const template = loadPrompt("apply-proposal", job.packageRoot || PACKAGE_ROOT);
  const present = new Set(readProposals(config.dir).map((proposal) => proposal.id));
  const groups = new Map<string, ApplyProposal[]>();
  for (const proposal of job.proposals) {
    if (!present.has(proposal.id)) {
      log(`proposal ${proposal.id} for ${proposal.skill} is no longer pending; skipping it`);
      continue;
    }
    groups.set(proposal.skill, [...(groups.get(proposal.skill) ?? []), proposal]);
  }
  const roots = skillIndexRoots({ agentDir: config.agentDir, home, cwd: job.cwd || home });
  const skills = await withLock(
    config.dir,
    async () => {
      const outcomes: SkillOutcome[] = [];
      for (const [skill, proposals] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
        let outcome: SkillOutcome;
        try {
          outcome = await applySkill(skill, proposals, locateSkill(skill, roots, config.dir, git), { model: deps.model, git, template });
        } catch (error) {
          outcome = { skill, status: "failed", ids: proposals.map((proposal) => proposal.id), reason: errorMessage(error), needsUser: false };
        }
        log(outcome.status === "applied" ? `applied ${outcome.ids.length} to ${skill}` : `${outcome.status} ${skill}: ${outcome.reason}`);
        outcomes.push(outcome);
      }
      const applied = outcomes.filter((outcome) => outcome.status === "applied");
      if (applied.length > 0) {
        const removal = removeProposals(config.dir, applied.flatMap((outcome) => outcome.ids), {
          autoCommit: config.autoCommit,
          message: removalMessage(applied),
          git,
        });
        if (removal.commit) log(removal.commit.committed ? "committed proposals.md" : `no proposals.md commit: ${removal.commit.reason}`);
      }
      return outcomes;
    },
    deps.lock,
  );
  updateProposalState(config.stateDir, (state) => {
    for (const outcome of skills) {
      for (const id of outcome.ids) {
        if (outcome.status === "applied") delete state.proposals[id];
        else updateNote(state, id, { applyingSince: undefined, lastError: `${outcome.status}: ${outcome.reason}`, needsUser: outcome.needsUser });
      }
    }
    for (const proposal of job.proposals) {
      if (!present.has(proposal.id)) delete state.proposals[proposal.id];
    }
  });
  return { outcome: overallOutcome(skills), skills, summary: summarizeApply(skills) };
}
