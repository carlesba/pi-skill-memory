import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { appendHistory } from "../src/history.ts";
import { emptyLedger, recordTopicVote, recordVote, saveLedger } from "../src/ledger.ts";
import { formatStats, parseStatsArgs } from "../src/commands.ts";
import { serializeTopic } from "../src/topics.ts";
import { appendUsageEvent, foldEventsIntoLedgers, foldUsageLog } from "../src/usage.ts";
import { appendRun } from "../src/writer/runs.ts";

function snapshot(path: string): unknown {
  return readdirSync(path).sort().map((name) => {
    const target = join(path, name);
    return [name, statSync(target).isDirectory() ? snapshot(target) : [readFileSync(target, "utf8"), statSync(target).mtimeMs]];
  });
}

test("stats combines full history, pending usage and capped legacy ledgers without writing", () => {
  const root = mkdtempSync(join(tmpdir(), "psm-stats-"));
  const config = { dir: join(root, "memory"), stateDir: join(root, "state") };
  const topicDir = join(config.dir, "memory-skills", "mem-any-tests");
  mkdirSync(topicDir, { recursive: true });
  writeFileSync(join(topicDir, "SKILL.md"), serializeTopic({ name: "mem-any-tests", description: "Tests", scope: "generic", updated: "2026-10-29", memories: [{ id: "r1", text: "Test behavior." }] }));
  const ledger = emptyLedger();
  ledger.memories.r1 = { source: "old", origin: "human", learned: "", votes: [] };
  const old = "2026-10-09T12:00:00.000Z";
  const ts = "2026-10-29T12:00:00.000Z";
  recordTopicVote(ledger, "reminded", old);
  recordVote(ledger, "r1", "confirmed", new Date(old));
  for (let index = 0; index < 30; index++) appendUsageEvent(config.stateDir, { topic: "mem-any-tests", kind: "loaded", session: "loaded-session", ts });
  foldUsageLog(config.stateDir, (events) => foldEventsIntoLedgers(events, () => ledger));
  assert.equal(ledger.topic.votes.filter((vote) => vote.kind === "loaded").length, 20);
  appendUsageEvent(config.stateDir, { topic: "mem-any-tests", kind: "reminded", session: "pending-session", ts });
  appendHistory(config.stateDir, "votes", { topic: "mem-any-tests", id: "r1", kind: "applied", session: "loaded-session", ts });
  recordVote(ledger, "r1", "applied", new Date(ts));
  saveLedger(join(topicDir, "ledger.json"), ledger);
  appendHistory(config.stateDir, "usage", { topic: "mem-gone", kind: "reminded", session: "gone-session", ts });
  appendHistory(config.stateDir, "votes", { topic: "user.md", id: "r2", kind: "retracted", session: "loaded-session", ts });
  appendHistory(config.stateDir, "extractions", { session: "writer-session", ts, dropped: [
    { type: "candidate", reason: "candidates[0].evidence is empty" },
    { type: "candidate", reason: "candidates[7].evidence is empty" },
    { type: "vote", reason: "invalid" },
  ] });
  appendRun(config.stateDir, { ts, session: "writer-session", outcome: "ok", topics: [] });
  appendRun(config.stateDir, { ts, session: "writer-session", kind: "apply", outcome: "failed", topics: [] });
  appendRun(config.stateDir, { ts: old, session: "old-session", outcome: "failed", topics: [], error: "pass 1 rejected: bad" });
  const before = snapshot(root);
  const output = formatStats(config, "2026-10-29");
  assert.match(output, /Sessions in window: 4 known/);
  assert.match(output, /0 ledger-only events/);
  assert.match(output, /mem-any-tests\s+1\s+30\s+0\s+0\s+1\s+0\s+0\s+0\s+0/);
  assert.match(output, /user.md\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+0\s+1/);
  assert.match(output, /Topics never loaded in window: mem-gone/);
  assert.match(output, /ok\s+1/);
  assert.doesNotMatch(output, /failed\s+1/);
  assert.match(output, /evidence is empty\s+2/);
  assert.match(output, /Votes dropped: 1/);
  const allTime = formatStats(config);
  assert.match(allTime, /2 ledger-only events \(capped, incomplete history\)/);
  assert.match(allTime, /mem-any-tests\s+2\s+30\s+0\s+0\s+1\s+1/);
  assert.match(allTime, /Pass-1 validation failures: 1/);
  assert.deepEqual(snapshot(root), before);
});

test("stats handles empty stores without creating directories and validates dates", () => {
  const root = mkdtempSync(join(tmpdir(), "psm-empty-stats-"));
  assert.match(formatStats({ dir: join(root, "missing"), stateDir: join(root, "state") }), /Sessions in window: 0 known/);
  assert.deepEqual(readdirSync(root), []);
  assert.equal(parseStatsArgs(["--since", "2024-02-29"]), "2024-02-29");
  assert.equal(parseStatsArgs([]), undefined);
  for (const args of [["--since"], ["--since", "2025-02-29"], ["--until", "2025-01-01"], ["--since", "2025-01-01", "extra"]]) {
    assert.throws(() => parseStatsArgs(args), /usage: stats/);
  }
});

test("stats counts selected and injected and matches later applied votes in the same session", () => {
  const root = mkdtempSync(join(tmpdir(), "psm-conversion-"));
  const config = { dir: join(root, "memory"), stateDir: join(root, "state") };
  for (const session of ["used", "unused"]) {
    appendUsageEvent(config.stateDir, { topic: "mem-test", kind: "selected", session, ts: "2026-10-29T10:00:00Z", mode: "inject" });
    appendUsageEvent(config.stateDir, { topic: "mem-test", kind: "injected", session, ts: "2026-10-29T10:00:01Z", mode: "inject" });
  }
  appendHistory(config.stateDir, "votes", { topic: "mem-test", id: "r1", kind: "applied", session: "used", ts: "2026-10-29T11:00:00Z" });
  appendHistory(config.stateDir, "votes", { topic: "mem-test", id: "r2", kind: "applied", session: "unused", ts: "2026-10-28T11:00:00Z" });
  assert.match(formatStats(config), /mem-test\s+0\s+0\s+2\s+2\s+2/);
  assert.match(formatStats(config), /Selected topic\/session pairs later applied: 1\/2/);
});

test("stats groups runs and accepted lessons by trigger and exposes repeated session confirmations", () => {
  const root = mkdtempSync(join(tmpdir(), "psm-trigger-stats-"));
  const config = { dir: join(root, "memory"), stateDir: join(root, "state") };
  const ts = "2026-10-29T12:00:00.000Z";
  for (const trigger of ["compaction", "recovery", "manual", "shutdown"] as const) {
    appendRun(config.stateDir, { ts, session: trigger, trigger, outcome: "ok", topics: [] });
    appendHistory(config.stateDir, "extractions", { ts, session: trigger, trigger, candidates: [{ rule: "Lesson" }] });
  }
  appendRun(config.stateDir, { ts, session: "legacy", outcome: "nothing", topics: [] });
  appendRun(config.stateDir, { ts, session: "proposal", kind: "apply", outcome: "ok", topics: [] });
  for (let i = 0; i < 2; i++) appendHistory(config.stateDir, "votes", {
    ts, session: "same", topic: "user.md", id: "r1", kind: "confirmed",
  });
  const text = formatStats(config);
  for (const trigger of ["compaction", "recovery", "manual", "shutdown"]) assert.match(text, new RegExp(`${trigger}\\s+1\\s+1`));
  assert.match(text, /unknown\s+1\s+0/);
  assert.match(text, /Repeated confirmed votes on the same memory\/session: 1/);
  assert.match(formatStats(config, "2026-10-30"), /compaction\s+0\s+0/);
});
