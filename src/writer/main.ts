import { mkdirSync, realpathSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadJob } from "./job.ts";
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

export async function runJob(jobFile: string, deps: RunJobDeps = {}): Promise<RunRecord> {
  const job = loadJob(jobFile);
  const stateDir = job.config.stateDir;
  const session = job.sessionId;
  const log = deps.log ?? ((line: string) => appendWriterLog(stateDir, `[${session}] ${line}`));
  mkdirSync(stateDir, { recursive: true });
  const model = deps.model ?? createPiRunner({ model: job.config.writerModel, cwd: stateDir });
  log(`writer started for ${job.sessionFile}`);
  let record: RunRecord;
  try {
    const result = await withLock(job.config.dir, () => runPipeline(job, { ...deps, model, log }), deps.lock);
    record = { ts: new Date().toISOString(), session, outcome: result.outcome, topics: result.topics };
    if (result.error) record.error = result.error;
    if (result.rejected.length > 0) record.rejected = result.rejected;
  } catch (error) {
    record = { ts: new Date().toISOString(), session, outcome: "failed", topics: [], error: errorMessage(error) };
  }
  log(`writer finished: ${record.outcome}${record.error ? ` (${record.error})` : ""}`);
  appendRun(stateDir, record);
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
