import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { acquireLock, LOCK_HEARTBEAT_MS, LOCK_STALE_MS, lockPath, LockTimeoutError, withLock } from "../src/writer/lock.ts";

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

test("the holder refreshes its lock, so a live writer keeps it however long it runs", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-lock-"));
  let clock = Date.parse("2025-06-01T00:00:00Z");
  const now = () => clock;
  const refreshes: (() => void)[] = [];
  let stopped = 0;
  const schedule = (refresh: () => void, ms: number) => {
    assert.equal(ms, LOCK_HEARTBEAT_MS);
    refreshes.push(refresh);
    return () => {
      stopped++;
    };
  };
  const alive = new Set([1001, 1002]);
  const isAlive = (pid: number) => alive.has(pid);
  const holder = { ...fast, now, isAlive, schedule, pid: 1001 };
  const waiter = { ...fast, now, isAlive, timeoutMs: 0, pid: 1002, schedule: () => () => undefined };
  const release = await acquireLock(dir, holder);
  assert.equal(refreshes.length, 1);
  const owner = () => JSON.parse(readFileSync(lockPath(dir), "utf8")) as { pid: number; ts: string };
  for (let minute = 0; minute < 40; minute++) {
    clock += LOCK_HEARTBEAT_MS;
    refreshes[0]!();
    assert.equal(owner().ts, new Date(clock).toISOString());
  }
  clock += LOCK_STALE_MS - 1000;
  await assert.rejects(acquireLock(dir, waiter), LockTimeoutError);
  assert.equal(owner().pid, 1001);
  clock += 2000;
  const taken = await acquireLock(dir, waiter);
  assert.equal(owner().pid, 1002);
  refreshes[0]!();
  assert.equal(owner().pid, 1002);
  release();
  assert.equal(stopped, 1);
  assert.equal(owner().pid, 1002);
  taken();
  assert.equal(existsSync(lockPath(dir)), false);
});

test("a fresh lock whose pid is dead is stale", async () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-lock-"));
  const clock = Date.parse("2025-06-01T00:00:00Z");
  writeFileSync(lockPath(dir), JSON.stringify({ pid: 1001, ts: new Date(clock).toISOString(), token: "dead" }));
  const release = await acquireLock(dir, { ...fast, now: () => clock, isAlive: () => false, timeoutMs: 0, pid: 1002 });
  assert.equal(JSON.parse(readFileSync(lockPath(dir), "utf8")).pid, 1002);
  release();
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
