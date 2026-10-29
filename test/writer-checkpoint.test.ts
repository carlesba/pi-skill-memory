import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { recoverableSessions } from "../src/writer/checkpoint.ts";
import { appendRun } from "../src/writer/runs.ts";
import { writeFixtureSession } from "./writer-helpers.ts";

test("recovery selects recent human top-level sessions, excludes recorded and queued runs, and caps work", async () => {
  const root = mkdtempSync(join(tmpdir(), "psm-recovery-"));
  const config = resolveConfig({ memory: { dir: join(root, "memory"), stateDir: join(root, "state"), recoverMaxSessions: 2 } },
    { env: { PI_CODING_AGENT_DIR: root }, home: root });
  const now = new Date();
  function session(id: string, subdir = "project", old = false) {
    const directory = join(root, "sessions", subdir);
    mkdirSync(directory, { recursive: true });
    const path = join(directory, `${id}.jsonl`);
    writeFixtureSession(path, { cwd: root, dir: config.dir });
    writeFileSync(path, readFileSync(path, "utf8").replace('"id":"sess-1"', `"id":"${id}"`));
    if (old) utimesSync(path, new Date(0), new Date(0));
    return path;
  }
  session("current"); session("done"); session("queued"); session("old", "project", true);
  session("child", "project/run-child"); session("direct-child", "run-child");
  session("one"); session("two"); session("three");
  appendRun(config.stateDir, { session: "done", ts: now.toISOString(), outcome: "failed", topics: [] });
  mkdirSync(join(config.stateDir, "jobs"), { recursive: true });
  writeFileSync(join(config.stateDir, "jobs", "pending.json"), JSON.stringify({ sessionId: "queued" }, null, 2));
  const found = await recoverableSessions(config, "current", now);
  assert.equal(found.length, 2);
  assert.ok(found.every((item) => ["one", "two", "three"].includes(item.sessionId)));
  assert.ok(found.every((item) => item.endEntryId === "e9"));
  assert.deepEqual(await recoverableSessions({ ...config, recoverDays: 0 }, "current", now), []);
  assert.deepEqual(await recoverableSessions({ ...config, recoverMaxSessions: 0 }, "current", now), []);
});
