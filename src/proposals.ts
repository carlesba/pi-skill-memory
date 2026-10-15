import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { commitPaths, runGit, type CommitOutcome, type GitExec } from "./writer/commit.ts";
import { confinedPath } from "./writer/confine.ts";
import { withLock, type LockOptions } from "./writer/lock.ts";

export const PROPOSALS_FILE = "proposals.md";

export interface Proposal {
  id: string;
  date: string;
  skill: string;
  rule: string;
  why: string;
  evidence: string;
  session: string;
}

interface ProposalBlock {
  proposal: Proposal;
  text: string;
}

interface ParsedProposals {
  preamble: string;
  blocks: ProposalBlock[];
}

const HEADING = /^## (\S+) proposal:(\S+)\s*$/;
const FIELD = /^- (Rule|Why|Evidence|Session):\s?(.*)$/;

export function proposalId(skill: string, rule: string, session: string): string {
  return createHash("sha256").update(`${skill}\n${rule}\n${session}`).digest("hex").slice(0, 10);
}

function unquoteEvidence(value: string): string {
  const trimmed = value.trim();
  return trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"') ? trimmed.slice(1, -1) : trimmed;
}

function parseBlock(date: string, skill: string, lines: string[]): Proposal {
  const fields: Record<string, string> = {};
  let last: string | null = null;
  for (const line of lines) {
    const match = FIELD.exec(line);
    if (match) {
      last = match[1]!;
      fields[last] = match[2]!.trim();
    } else if (last && line.trim() !== "") {
      fields[last] = `${fields[last]} ${line.trim()}`.trim();
    }
  }
  const rule = fields.Rule ?? "";
  const session = fields.Session ?? "";
  return {
    id: proposalId(skill, rule, session),
    date,
    skill,
    rule,
    why: fields.Why ?? "",
    evidence: unquoteEvidence(fields.Evidence ?? ""),
    session,
  };
}

function splitProposals(raw: string): ParsedProposals {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const preamble: string[] = [];
  const blocks: ProposalBlock[] = [];
  let current: { date: string; skill: string; lines: string[] } | null = null;
  const close = () => {
    if (!current) return;
    const body = current.lines.slice(1);
    blocks.push({
      proposal: parseBlock(current.date, current.skill, body),
      text: current.lines.join("\n").replace(/\s+$/, ""),
    });
  };
  for (const line of lines) {
    const heading = HEADING.exec(line);
    if (heading) {
      close();
      current = { date: heading[1]!, skill: heading[2]!, lines: [line] };
    } else if (current) {
      current.lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  close();
  return { preamble: preamble.join("\n").trim(), blocks };
}

export function parseProposals(raw: string): Proposal[] {
  return splitProposals(raw).blocks.map((block) => block.proposal);
}

export function withoutProposals(raw: string, ids: Iterable<string>): string {
  const removed = new Set(ids);
  const parsed = splitProposals(raw);
  const kept = parsed.blocks.filter((block) => !removed.has(block.proposal.id)).map((block) => block.text);
  const parts = parsed.preamble === "" ? kept : [parsed.preamble, ...kept];
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

export function proposalsPath(dir: string): string {
  return confinedPath(dir, PROPOSALS_FILE);
}

function readText(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

export function readProposals(dir: string): Proposal[] {
  return parseProposals(readText(proposalsPath(dir)));
}

export function writeFileAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

export interface RemoveProposalsOptions {
  autoCommit: boolean;
  message: string;
  git?: GitExec;
}

export interface RemoveProposalsResult {
  removed: string[];
  commit: CommitOutcome | null;
}

export function removeProposals(dir: string, ids: string[], options: RemoveProposalsOptions): RemoveProposalsResult {
  const path = proposalsPath(dir);
  const raw = readText(path);
  const present = new Set(parseProposals(raw).map((proposal) => proposal.id));
  const removed = ids.filter((id) => present.has(id));
  if (removed.length === 0) return { removed, commit: null };
  writeFileAtomic(path, withoutProposals(raw, removed));
  const commit = options.autoCommit ? commitPaths(dir, [PROPOSALS_FILE], options.message, options.git ?? runGit) : null;
  return { removed, commit };
}

export interface DiscardOptions {
  autoCommit: boolean;
  git?: GitExec;
  lock?: LockOptions;
}

export function discardMessage(proposal: Proposal): string {
  return `memory: discard proposal for ${proposal.skill}\n\n${proposal.rule}\n`;
}

export function discardProposal(dir: string, proposal: Proposal, options: DiscardOptions): Promise<RemoveProposalsResult> {
  return withLock(
    dir,
    async () => removeProposals(dir, [proposal.id], { autoCommit: options.autoCommit, git: options.git, message: discardMessage(proposal) }),
    options.lock,
  );
}
