import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runApply } from "./apply.ts";
import { loadJob, type ApplyJob } from "./job.ts";
import { withLock, type LockOptions } from "./lock.ts";
import { createPiRunner, type ModelRunner } from "./model.ts";
import { runPipeline, type PipelineDeps } from "./pipeline.ts";
import { appendRun, appendWriterLog, type RunRecord } from "./runs.ts";

export interface RunJobDeps extends Partial<PipelineDeps> {
  model?: ModelRunner;
  lock?: LockOptions;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function runApplyJob(job: ApplyJob, deps: RunJobDeps, log: (line: string) => void, model: ModelRunner): Promise<RunRecord> {
  log(`proposal apply started for ${job.proposals.length} proposals`);
  let record: RunRecord;
  try {
    const result = await runApply(job, { model, git: deps.git, log, home: deps.home, lock: deps.lock });
    const reasons = result.skills.flatMap((outcome) => (outcome.status === "applied" ? [] : [`${outcome.skill}: ${outcome.reason}`]));
    record = {
      kind: "apply",
      ts: new Date().toISOString(),
      session: job.sessionId,
      outcome: result.outcome,
      topics: result.skills.filter((outcome) => outcome.status === "applied").map((outcome) => outcome.skill),
      summary: result.summary,
    };
    if (reasons.length > 0) record.error = reasons.join("; ");
  } catch (error) {
    record = { kind: "apply", ts: new Date().toISOString(), session: job.sessionId, outcome: "failed", topics: [], error: errorMessage(error) };
  }
  log(`proposal apply finished: ${record.outcome}${record.summary ? ` (${record.summary})` : ""}`);
  return record;
}

export async function runJob(jobFile: string, deps: RunJobDeps = {}): Promise<RunRecord> {
  const job = loadJob(jobFile);
  const stateDir = job.config.stateDir;
  const session = job.sessionId;
  const log = deps.log ?? ((line: string) => appendWriterLog(stateDir, `[${session}] ${line}`));
  mkdirSync(stateDir, { recursive: true });
  const model = deps.model ?? createPiRunner({ model: job.config.writerModel, extensions: job.config.writerExtensions, cwd: stateDir });
  if (job.kind === "apply") {
    const record = await runApplyJob(job, deps, log, model);
    appendRun(stateDir, record);
    if (record.outcome !== "failed") rmSync(jobFile, { force: true });
    return record;
  }
  log(`writer started for ${job.sessionFile}`);
  let record: RunRecord;
  try {
    record = await withLock(job.config.dir, async () => {
      const result = await runPipeline(job, { ...deps, model, log });
      const completed: RunRecord = { ts: new Date().toISOString(), session, outcome: result.outcome, topics: result.topics,
        trigger: job.trigger ?? "shutdown", ...(job.endEntryId ? { endEntryId: job.endEntryId } : {}) };
      if (result.error) completed.error = result.error;
      if (result.rejected.length > 0) completed.rejected = result.rejected;
      appendRun(stateDir, completed);
      return completed;
    }, deps.lock);
  } catch (error) {
    record = { ts: new Date().toISOString(), session, outcome: "failed", topics: [], error: errorMessage(error),
      trigger: job.trigger ?? "shutdown", ...(job.endEntryId ? { endEntryId: job.endEntryId } : {}) };
    appendRun(stateDir, record);
  }
  log(`writer finished: ${record.outcome}${record.error ? ` (${record.error})` : ""}`);
  if (record.outcome !== "failed") rmSync(jobFile, { force: true });
  return record;
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  const jobFile = process.argv[2];
  if (!jobFile) {
    console.error("usage: node src/writer/main.ts <jobfile>");
    process.exitCode = 2;
  } else {
    runJob(jobFile).then(
      (record) => {
        process.exitCode = record.outcome === "failed" ? 1 : 0;
      },
      (error: unknown) => {
        console.error(`pi-skill-memory writer: ${errorMessage(error)}`);
        process.exitCode = 1;
      },
    );
  }
}
