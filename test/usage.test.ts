import { strict as assert } from "node:assert";
import { existsSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { emptyLedger, type Ledger } from "../src/ledger.ts";
import {
  appendUsageEvent,
  foldEventsIntoLedgers,
  foldUsageLog,
  parseUsageLog,
  readUsageEvents,
  topicsLoadedInSession,
  type UsageEvent,
} from "../src/usage.ts";

function event(kind: UsageEvent["kind"], topic: string, session: string, ts: string): UsageEvent {
  return { ts, kind, topic, session };
}

test("appends one JSON line per event and skips malformed lines when reading", () => {
  const stateDir = join(mkdtempSync(join(tmpdir(), "psm-usage-")), "state");
  appendUsageEvent(stateDir, event("reminded", "mem-a", "s1", "2025-01-01T00:00:00Z"));
  appendUsageEvent(stateDir, event("loaded", "mem-a", "s1", "2025-01-01T00:01:00Z"));
  assert.equal(readUsageEvents(stateDir).length, 2);
  assert.deepEqual(parseUsageLog('nope\n{"ts":"t","kind":"bogus","topic":"x","session":"s"}\n'), []);
});

test("folds by renaming the log, so appends during the fold land in a fresh file", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "psm-usage-"));
  appendUsageEvent(stateDir, event("loaded", "mem-a", "s1", "2025-01-01T00:00:00Z"));
  appendUsageEvent(stateDir, event("reminded", "mem-b", "s1", "2025-01-01T00:00:01Z"));
  let seenDuringFold: string[] = [];
  const folded = foldUsageLog(
    stateDir,
    (events) => {
      seenDuringFold = readdirSync(stateDir).sort();
      appendUsageEvent(stateDir, event("loaded", "mem-a", "s2", "2025-01-02T00:00:00Z"));
      assert.equal(events.length, 2);
    },
    { pid: 42, isAlive: () => true },
  );
  assert.equal(folded.length, 2);
  assert.deepEqual(seenDuringFold, ["usage.42.folding.jsonl"]);
  assert.deepEqual(readdirSync(stateDir), ["usage.jsonl"]);
  assert.deepEqual(readUsageEvents(stateDir).map((entry) => entry.session), ["s2"]);
  assert.deepEqual(foldUsageLog(join(stateDir, "missing"), () => assert.fail("no fold")), []);
});

test("recovers folding files left by dead processes but not live ones", () => {
  const stateDir = mkdtempSync(join(tmpdir(), "psm-usage-"));
  writeFileSync(join(stateDir, "usage.7.folding.jsonl"), `${JSON.stringify(event("loaded", "mem-dead", "s", "t1"))}\n`);
  writeFileSync(join(stateDir, "usage.8.folding.jsonl"), `${JSON.stringify(event("loaded", "mem-live", "s", "t2"))}\n`);
  appendUsageEvent(stateDir, event("loaded", "mem-new", "s", "t3"));
  const folded = foldUsageLog(stateDir, () => {}, { pid: 1, isAlive: (pid) => pid === 8 });
  assert.deepEqual(folded.map((entry) => entry.topic).sort(), ["mem-dead", "mem-new"]);
  assert.equal(existsSync(join(stateDir, "usage.8.folding.jsonl")), true);
  assert.equal(existsSync(join(stateDir, "usage.7.folding.jsonl")), false);
});

test("folds events into topic ledgers in time order and finds topics loaded in a session", () => {
  const ledgers: Record<string, Ledger> = { "mem-a": emptyLedger() };
  const events = [
    event("loaded", "mem-a", "s1", "2025-01-02T00:00:00Z"),
    event("reminded", "mem-a", "s1", "2025-01-01T00:00:00Z"),
    event("loaded", "mem-gone", "s1", "2025-01-01T00:00:00Z"),
    event("loaded", "mem-a", "s2", "2025-01-03T00:00:00Z"),
  ];
  const touched = foldEventsIntoLedgers(events, (topic) => ledgers[topic] ?? null);
  assert.deepEqual([...touched], ["mem-a"]);
  assert.deepEqual(ledgers["mem-a"]!.topic.votes.map((vote) => vote.kind), ["reminded", "loaded", "loaded"]);
  assert.deepEqual(topicsLoadedInSession(events, "s1"), ["mem-a", "mem-gone"]);
});
