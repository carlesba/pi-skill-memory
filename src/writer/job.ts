import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveConfig, type MemoryConfig } from "../config.ts";

export interface WriterJob {
  config: MemoryConfig;
  sessionFile: string;
  sessionId: string;
  cwd: string;
  packageRoot: string;
  force: boolean;
  createdAt: string;
}

export function jobsDir(stateDir: string): string {
  return join(stateDir, "jobs");
}

function fileSafe(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, "-");
}

export function writeJob(job: WriterJob): string {
  const directory = jobsDir(job.config.stateDir);
  mkdirSync(directory, { recursive: true });
  const stamp = job.createdAt.replace(/[:.]/g, "-");
  const path = join(directory, `${fileSafe(stamp)}-${fileSafe(job.sessionId || "session")}.json`);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(job, null, 2)}\n`);
  renameSync(temporary, path);
  return path;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseJob(raw: string): WriterJob {
  const data: unknown = JSON.parse(raw);
  if (!isRecord(data) || !isRecord(data.config)) throw new Error("job file is not an object with a config");
  if (typeof data.sessionFile !== "string" || data.sessionFile === "") throw new Error("job file has no sessionFile");
  const stored = data.config;
  const defaults = resolveConfig({ memory: stored });
  const config: MemoryConfig = {
    ...defaults,
    agentDir: typeof stored.agentDir === "string" ? stored.agentDir : defaults.agentDir,
    dir: typeof stored.dir === "string" ? stored.dir : defaults.dir,
    stateDir: typeof stored.stateDir === "string" ? stored.stateDir : defaults.stateDir,
  };
  return {
    config,
    sessionFile: data.sessionFile,
    sessionId: typeof data.sessionId === "string" ? data.sessionId : "",
    cwd: typeof data.cwd === "string" ? data.cwd : "",
    packageRoot: typeof data.packageRoot === "string" ? data.packageRoot : "",
    force: data.force === true,
    createdAt: typeof data.createdAt === "string" ? data.createdAt : new Date().toISOString(),
  };
}

export function loadJob(path: string): WriterJob {
  return parseJob(readFileSync(path, "utf8"));
}
