import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { MEMORY_SKILLS_DIR } from "../topics.ts";

export interface GitResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type GitExec = (args: string[], cwd: string) => GitResult;

export const COMMIT_PATHS = ["user.md", "user.ledger.json", MEMORY_SKILLS_DIR, "proposals.md"];

export const runGit: GitExec = (args, cwd) => {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 60_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
};

export interface CommitSummary {
  topics: string[];
  userMemory: boolean;
  proposals: string[];
  removed: { topic: string; id: string; why: string }[];
  deletedTopics: { topic: string; why: string }[];
}

export function buildCommitMessage(summary: CommitSummary): string {
  const touched = [...summary.topics, ...(summary.userMemory ? ["user.md"] : [])];
  const subject = touched.length > 0 ? `memory: update ${touched.join(", ")}` : "memory: update ledgers";
  const lines: string[] = [];
  if (summary.topics.length > 0) lines.push("Topics:", ...summary.topics.map((topic) => `- ${topic}`));
  if (summary.removed.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Removed:", ...summary.removed.map((entry) => `- ${entry.topic} ${entry.id}: ${entry.why}`));
  }
  if (summary.deletedTopics.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Deleted topics:", ...summary.deletedTopics.map((entry) => `- ${entry.topic}: ${entry.why}`));
  }
  if (summary.proposals.length > 0) {
    if (lines.length > 0) lines.push("");
    lines.push("Proposals:", ...summary.proposals.map((skill) => `- ${skill}`));
  }
  return lines.length > 0 ? `${subject}\n\n${lines.join("\n")}\n` : `${subject}\n`;
}

export function isGitWorkTree(dir: string, git: GitExec = runGit): boolean {
  const result = git(["rev-parse", "--is-inside-work-tree"], dir);
  return result.status === 0 && result.stdout.trim() === "true";
}

export type CommitOutcome = { committed: true } | { committed: false; reason: string };

export function commitMemory(dir: string, message: string, git: GitExec = runGit): CommitOutcome {
  if (!isGitWorkTree(dir, git)) return { committed: false, reason: "not a git work tree" };
  const paths = COMMIT_PATHS.filter(
    (path) => existsSync(join(dir, path)) || git(["ls-files", "--", path], dir).stdout.trim() !== "",
  );
  if (paths.length === 0) return { committed: false, reason: "nothing to commit" };
  const add = git(["add", "-A", "--", ...paths], dir);
  if (add.status !== 0) return { committed: false, reason: `git add failed: ${add.stderr.trim()}` };
  const diff = git(["diff", "--cached", "--quiet", "--", ...paths], dir);
  if (diff.status === 0) return { committed: false, reason: "nothing to commit" };
  const commit = git(["commit", "--only", "-m", message, "--", ...paths], dir);
  if (commit.status !== 0) return { committed: false, reason: `git commit failed: ${commit.stderr.trim()}` };
  return { committed: true };
}
