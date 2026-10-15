import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, type MemoryConfig } from "../config.ts";

interface JobBase {
  config: MemoryConfig;
  sessionId: string;
  cwd: string;
  packageRoot: string;
  createdAt: string;
}

export interface WriterJob extends JobBase {
  kind?: "write";
  sessionFile: string;
  force: boolean;
}

export interface ApplyProposal {
  id: string;
  skill: string;
  rule: string;
  why: string;
  evidence: string;
  comment: string;
}

export interface ApplyJob extends JobBase {
  kind: "apply";
  proposals: ApplyProposal[];
}

export type QueuedJob = WriterJob | ApplyJob;

export function jobsDir(stateDir: string): string {
  return join(stateDir, "jobs");
}

function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function writeJob(job: QueuedJob): string {
  const directory = jobsDir(job.config.stateDir);
  mkdirSync(directory, { recursive: true });
  const stamp = job.createdAt.replace(/[:.]/g, "-");
  const label = job.kind === "apply" ? `apply-${job.sessionId || "session"}` : job.sessionId || "session";
  const path = join(directory, `${fileSafe(stamp)}-${fileSafe(label)}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`);
  renameSync(temporary, path);
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function readApplyProposal(value: unknown): ApplyProposal | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.skill !== "string" || typeof value.rule !== "string") return null;
  return {
    id: value.id,
    skill: value.skill,
    rule: value.rule,
    why: readString(value.why),
    evidence: readString(value.evidence),
    comment: readString(value.comment),
  };
}

export function parseJob(raw: string): QueuedJob {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || !isRecord(data.config)) throw new Error("job file is not an object with a config");
  const stored = data.config;
  const defaults = resolveConfig({ memory: stored });
  const config: MemoryConfig = {
    ...defaults,
    agentDir: typeof stored.agentDir === "string" ? stored.agentDir : defaults.agentDir,
    dir: typeof stored.dir === "string" ? stored.dir : defaults.dir,
    stateDir: typeof stored.stateDir === "string" ? stored.stateDir : defaults.stateDir,
  };
  const base = {
    config,
    sessionId: readString(data.sessionId),
    cwd: readString(data.cwd),
    packageRoot: readString(data.packageRoot),
    createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
  };
  if (data.kind === "apply") {
    if (!Array.isArray(data.proposals)) throw new Error("apply job has no proposals");
    const proposals = data.proposals.map(readApplyProposal).filter((proposal): proposal is ApplyProposal => proposal !== null);
    return { ...base, kind: "apply", proposals };
  }
  if (typeof data.sessionFile !== "string" || data.sessionFile === "") throw new Error("job file has no sessionFile");
  return { ...base, sessionFile: data.sessionFile, force: data.force === true };
}

export function loadJob(path: string): QueuedJob {
  return parseJob(readFileSync(path, "utf8"));
}
