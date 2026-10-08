import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, lockPath, LockTimeoutError, withLock } from "../src/writer/lock.ts";

const fast = { pollMs: 5 };

test("two concurrent writers run strictly one after another", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-lock-"));
  const timeline: string[] = [];
  const work = (name: string) =>
    withLock(
      dir,
      async () => {
        timeline.push(`${name}:start`);
        assert.ok(existsSync(lockPath(dir)));
        await new Promise((resolve) => setTimeout(resolve, 40));
        timeline.push(`${name}:end`);
        return name;
      },
      fast,
    );
  const results = await Promise.all([work("a"), work("b")]);
  assert.deepEqual(results, ["a", "b"]);
  assert.equal(timeline.length, 4);
  assert.equal(timeline[0]!.split(":")[0], timeline[1]!.split(":")[0]);
  assert.match(timeline[1]!, /:end$/);
  assert.match(timeline[2]!, /:start$/);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("releases the lock when the work throws", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-lock-"));
  await assert.rejects(withLock(dir, async () => Promise.reject(new Error("boom")), fast), /boom/);
  assert.equal(existsSync(lockPath(dir)), false);
});

test("reclaims a lock held by a dead pid or older than the stale age", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-lock-"));
  writeFileSync(lockPath(dir), JSON.stringify({ pid: 424242, ts: new Date().toISOString(), token: "old" }));
  const release = await acquireLock(dir, { ...fast, timeoutMs: 50, isAlive: (pid) => pid !== 424242 });
  assert.equal(JSON.parse(readFileSync(lockPath(dir), "utf8")).pid, process.pid);
  release();
  writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, ts: "2000-01-01T00:00:00.000Z", token: "old" }));
  const releaseOld = await acquireLock(dir, { ...fast, timeoutMs: 50 });
  assert.notEqual(JSON.parse(readFileSync(lockPath(dir), "utf8")).token, "old");
  releaseOld();
  writeFileSync(lockPath(dir), "garbage");
  const past = new Date(Date.now() - 60_000);
  utimesSync(lockPath(dir), past, past);
  (await acquireLock(dir, { ...fast, timeoutMs: 50 }))();
});

test("waits for a live lock and times out", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-lock-"));
  writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, ts: new Date().toISOString(), token: "live" }));
  await assert.rejects(acquireLock(dir, { ...fast, timeoutMs: 30 }), LockTimeoutError);
  assert.equal(JSON.parse(readFileSync(lockPath(dir), "utf8")).token, "live");
});

test("two writer processes serialize on the lock file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-lock-"));
  const log = join(dir, "timeline.txt");
  const lockModule = new URL("../src/writer/lock.ts", import.meta.url).href;
  const script = `
    import { appendFileSync } from "node:fs";
    const { withLock } = await import(${JSON.stringify(lockModule)});
    await withLock(process.argv[1], async () => {
      appendFileSync(process.argv[2], "start\\n");
      await new Promise((resolve) => setTimeout(resolve, 150));
      appendFileSync(process.argv[2], "end\\n");
    }, { pollMs: 10 });
  `;
  const run = () =>
    new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, ["--input-type=module", "-e", script, dir, log], { stdio: "inherit" });
      child.on("close", resolve);
    });
  assert.deepEqual(await Promise.all([run(), run()]), [0, 0]);
  assert.equal(readFileSync(log, "utf8"), "start\nend\nstart\nend\n");
});
