import { spawn as nodeSpawn, spawnSync } from "node:child_process";
import { accessSync, closeSync, constants, existsSync, mkdirSync, openSync } from "node:fs";
import { delimiter, join } from "node:path";
import type { RunnerKind } from "../config.ts";
import { writeJob, type WriterJob } from "./job.ts";
import type { SpawnFunction } from "./model.ts";
import { PACKAGE_ROOT } from "./prompts.ts";
import { appendWriterLog, writerLogPath } from "./runs.ts";

export interface ExecResult {
  status: number;
  stdout: string;
  stderr: string;
}

export type Which = (command: string) => string | null;
export type Exec = (command: string, args: string[]) => ExecResult;

export interface EnqueueDeps {
  which?: Which;
  exec?: Exec;
  spawn?: SpawnFunction;
  log?: (line: string) => void;
}

export interface EnqueueResult {
  jobFile: string;
  runner: RunnerKind;
}

export const findOnPath: Which = (command) => {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (directory === "") continue;
    const candidate = join(directory, command);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
};

export const execCommand: Exec = (command, args) => {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 15_000 });
  return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? String(result.error ?? "") };
};

export function writerMainPath(packageRoot: string = PACKAGE_ROOT, exists: (path: string) => boolean = existsSync): string {
  const compiled = join(packageRoot, "dist", "writer", "main.js");
  return exists(compiled) ? compiled : join(packageRoot, "src", "writer", "main.ts");
}

export function writerCommand(
  packageRoot: string,
  jobFile: string,
  exists: (path: string) => boolean = existsSync,
): string[] {
  return [process.execPath, writerMainPath(packageRoot || PACKAGE_ROOT, exists), jobFile];
}

export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_@%+=:,./-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

export function launchDetached(command: string[], stateDir: string, spawn: SpawnFunction = nodeSpawn): void {
  mkdirSync(stateDir, { recursive: true });
  const output = openSync(writerLogPath(stateDir), "a");
  try {
    const child = spawn(command[0]!, command.slice(1), {
      detached: true,
      stdio: ["ignore", output, output],
      cwd: stateDir,
      env: process.env,
    });
    child.on("error", (error) => appendWriterLog(stateDir, `detached writer failed to start: ${error.message}`));
    child.unref();
  } finally {
    closeSync(output);
  }
}

function pueueGroups(exec: Exec): string[] | null {
  const result = exec("pueue", ["group", "--json"]);
  if (result.status !== 0) return null;
  try {
    const data = JSON.parse(result.stdout) as Record<string, unknown>;
    const groups = typeof data.groups === "object" && data.groups !== null ? (data.groups as Record<string, unknown>) : data;
    return Object.keys(groups);
  } catch {
    return null;
  }
}

function checked(result: ExecResult, what: string): void {
  if (result.status !== 0) throw new Error(`${what} failed: ${result.stderr.trim() || `exit ${result.status}`}`);
}

export function ensurePueueGroup(group: string, exec: Exec): void {
  const groups = pueueGroups(exec);
  if (groups === null) throw new Error("pueue group --json failed; is the pueue daemon running?");
  if (!groups.includes(group)) checked(exec("pueue", ["group", "add", group]), `pueue group add ${group}`);
  checked(exec("pueue", ["parallel", "1", "-g", group]), `pueue parallel 1 -g ${group}`);
}

export function launchPueue(command: string[], group: string, stateDir: string, exec: Exec): void {
  ensurePueueGroup(group, exec);
  const shellCommand = `${command.map(shellQuote).join(" ")} >> ${shellQuote(writerLogPath(stateDir))} 2>&1`;
  checked(exec("pueue", ["add", "-g", group, "--", shellCommand]), "pueue add");
}

export function enqueueWriter(job: WriterJob, deps: EnqueueDeps = {}): EnqueueResult {
  const stateDir = job.config.stateDir;
  const log = deps.log ?? ((line: string) => appendWriterLog(stateDir, line));
  const jobFile = writeJob(job);
  const command = writerCommand(job.packageRoot, jobFile);
  if (job.config.runner === "pueue") {
    const which = deps.which ?? findOnPath;
    if (which("pueue") === null) {
      log("runner pueue selected but pueue is not on PATH; falling back to detached");
    } else {
      try {
        launchPueue(command, job.config.pueueGroup, stateDir, deps.exec ?? execCommand);
        log(`queued writer for ${job.sessionId} in pueue group ${job.config.pueueGroup}`);
        return { jobFile, runner: "pueue" };
      } catch (error) {
        log(`pueue failed (${(error as Error).message}); falling back to detached`);
      }
    }
  }
  launchDetached(command, stateDir, deps.spawn ?? nodeSpawn);
  log(`started detached writer for ${job.sessionId}`);
  return { jobFile, runner: "detached" };
}
