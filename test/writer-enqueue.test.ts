import { strict as assert } from "node:assert";
import { EventEmitter } from "node:events";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { enqueueWriter, shellQuote, type Exec, type ExecResult } from "../src/writer/enqueue.ts";
import { loadJob, type WriterJob } from "../src/writer/job.ts";
import type { SpawnFunction } from "../src/writer/model.ts";

function makeJob(runner: "pueue" | "detached"): WriterJob {
  const root = mkdtempSync(join(tmpdir(), "psm-enqueue-"));
  const config = resolveConfig({ memory: { dir: join(root, "memory"), stateDir: join(root, "state with space"), runner } });
  return {
    config,
    sessionFile: join(root, "session.jsonl"),
    sessionId: "sess-1",
    cwd: root,
    packageRoot: "/pkg",
    force: false,
    createdAt: "2025-03-01T10:00:00.000Z",
  };
}

function fakeSpawn() {
  const calls: { command: string; args: readonly string[]; options: Record<string, unknown>; unref: boolean }[] = [];
  const spawn = ((command: string, args: readonly string[], options: Record<string, unknown>) => {
    const child = new EventEmitter() as EventEmitter & { unref: () => void };
    const call = { command, args, options, unref: false };
    child.unref = () => {
      call.unref = true;
    };
    calls.push(call);
    return child;
  }) as unknown as SpawnFunction;
  return { spawn, calls };
}

function fakeExec(groups: string[]) {
  const calls: string[][] = [];
  const exec: Exec = (command, args): ExecResult => {
    calls.push([command, ...args]);
    if (args[0] === "group" && args[1] === "--json") {
      return { status: 0, stdout: JSON.stringify(Object.fromEntries(groups.map((group) => [group, { status: "Running", parallel_tasks: 1 }]))), stderr: "" };
    }
    return { status: 0, stdout: "", stderr: "" };
  };
  return { exec, calls };
}

test("pueue missing from PATH falls back to a detached writer and logs it", () => {
  const job = makeJob("pueue");
  const { spawn, calls } = fakeSpawn();
  const { exec, calls: execCalls } = fakeExec([]);
  const result = enqueueWriter(job, { which: () => null, spawn, exec });
  assert.equal(result.runner, "detached");
  assert.equal(execCalls.length, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]!.command, process.execPath);
  assert.deepEqual(calls[0]!.args, ["/pkg/src/writer/main.ts", result.jobFile]);
  assert.equal(calls[0]!.options.detached, true);
  assert.equal(calls[0]!.unref, true);
  const log = readFileSync(join(job.config.stateDir, "writer.log"), "utf8");
  assert.match(log, /pueue is not on PATH; falling back to detached/);
  assert.equal(loadJob(result.jobFile).sessionId, "sess-1");
  assert.match(result.jobFile, /jobs\/2025-03-01T10-00-00-000Z-sess-1\.json$/);
});

test("pueue present creates the group at parallel 1 when missing and adds the writer", () => {
  const job = makeJob("pueue");
  const { spawn, calls } = fakeSpawn();
  const { exec, calls: execCalls } = fakeExec(["default"]);
  const lines: string[] = [];
  const result = enqueueWriter(job, { which: () => "/usr/bin/pueue", spawn, exec, log: (line) => lines.push(line) });
  assert.equal(result.runner, "pueue");
  assert.equal(calls.length, 0);
  const writerLog = join(job.config.stateDir, "writer.log");
  assert.deepEqual(execCalls, [
    ["pueue", "group", "--json"],
    ["pueue", "group", "add", "pi-skill-memory"],
    ["pueue", "parallel", "1", "-g", "pi-skill-memory"],
    [
      "pueue",
      "add",
      "-g",
      "pi-skill-memory",
      "--",
      `${shellQuote(process.execPath)} /pkg/src/writer/main.ts ${shellQuote(result.jobFile)} >> ${shellQuote(writerLog)} 2>&1`,
    ],
  ]);
  assert.match(execCalls[3]![5]!, /'[^']*state with space[^']*'/);
  assert.ok(existsSync(result.jobFile));
});

test("pueue with an existing group skips group add; a failing pueue falls back to detached", () => {
  const { exec, calls } = fakeExec(["default", "pi-skill-memory"]);
  enqueueWriter(makeJob("pueue"), { which: () => "/usr/bin/pueue", spawn: fakeSpawn().spawn, exec, log: () => undefined });
  assert.ok(!calls.some((call) => call[1] === "group" && call[2] === "add"));
  const broken: Exec = () => ({ status: 1, stdout: "", stderr: "daemon not running" });
  const detached = fakeSpawn();
  const lines: string[] = [];
  const result = enqueueWriter(makeJob("pueue"), { which: () => "/usr/bin/pueue", spawn: detached.spawn, exec: broken, log: (line) => lines.push(line) });
  assert.equal(result.runner, "detached");
  assert.equal(detached.calls.length, 1);
  assert.ok(lines.some((line) => /falling back to detached/.test(line)));
});

test("the detached runner never consults pueue", () => {
  const { spawn, calls } = fakeSpawn();
  let asked = false;
  const result = enqueueWriter(makeJob("detached"), { which: () => ((asked = true), "/x"), spawn, log: () => undefined });
  assert.equal(result.runner, "detached");
  assert.equal(asked, false);
  assert.equal(calls.length, 1);
});
