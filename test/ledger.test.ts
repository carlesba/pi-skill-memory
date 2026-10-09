import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  MAX_VOTES,
  emptyLedger,
  loadLedger,
  mintId,
  parseLedger,
  recordTopicVote,
  recordVote,
  reserveIdsAbove,
  saveLedger,
  sweepLedger,
} from "../src/ledger.ts";
import { isStaleTopic, topicWeight } from "../src/weights.ts";
import { memoryIds, parseMemories, serializeMemories, withoutMemories } from "../src/topics.ts";

const now = new Date("2025-06-01T12:00:00Z");

test("mints monotonic ids that are never reused after deletion", () => {
  const ledger = emptyLedger();
  assert.equal(mintId(ledger, "s1", now), "r1");
  assert.equal(mintId(ledger, "s1", now), "r2");
  assert.deepEqual(ledger.memories.r1, { source: "s1", origin: "human", learned: "2025-06-01", votes: [] });
  sweepLedger(ledger, ["r1"]);
  assert.equal(mintId(ledger, "s2", now), "r3");
  const reloaded = parseLedger(JSON.stringify({ nextId: 1, memories: { r9: { source: "x", learned: "2025-01-01" } } }));
  assert.equal(reloaded.nextId, 10);
  reserveIdsAbove(reloaded, ["r15", "new", "r3"]);
  assert.equal(mintId(reloaded, "s", now), "r16");
});

test("sweep deletes entries whose id no longer appears in the body", () => {
  const ledger = emptyLedger();
  for (let index = 0; index < 4; index++) mintId(ledger, "s", now);
  const body = "Keep this ^r1\n\nAnd this ^r3\n\nBrand new ^new";
  assert.deepEqual(sweepLedger(ledger, memoryIds(body)), ["r2", "r4"]);
  assert.deepEqual(Object.keys(ledger.memories), ["r1", "r3"]);
  assert.equal(ledger.nextId, 5);
});

test("records votes keeping the last 20 and retracts by deleting the entry", () => {
  const ledger = emptyLedger();
  const id = mintId(ledger, "s", now);
  for (let index = 0; index < MAX_VOTES + 5; index++) {
    assert.equal(recordVote(ledger, id, "applied", new Date(now.getTime() + index * 1000)), "recorded");
  }
  assert.equal(ledger.memories[id]!.votes.length, MAX_VOTES);
  assert.equal(ledger.memories[id]!.votes[0]!.ts, new Date(now.getTime() + 5000).toISOString());
  assert.equal(recordVote(ledger, "r99", "applied", now), "unknown");
  assert.equal(recordVote(ledger, id, "retracted", now), "retracted");
  assert.equal(ledger.memories[id], undefined);
  const memories = withoutMemories(parseMemories(`A ^${id}\n\nB ^r2`), [id]);
  assert.equal(serializeMemories(memories), "B ^r2");
  for (let index = 0; index < MAX_VOTES + 1; index++) recordTopicVote(ledger, "loaded", now.toISOString());
  assert.equal(ledger.topic.votes.length, MAX_VOTES);
});

test("reminded votes never push loaded votes out of the topic window", () => {
  const ledger = emptyLedger(new Date(now.getTime() - 200 * 86_400_000).toISOString());
  const loadedAt = new Date(now.getTime() - 5 * 86_400_000);
  recordTopicVote(ledger, "loaded", loadedAt.toISOString());
  for (let index = 0; index < 30; index++) {
    recordTopicVote(ledger, "reminded", new Date(loadedAt.getTime() + (index + 1) * 60_000).toISOString());
  }
  const kinds = (votes: { kind: string }[], kind: string) => votes.filter((vote) => vote.kind === kind).length;
  assert.equal(kinds(ledger.topic.votes, "loaded"), 1);
  assert.equal(kinds(ledger.topic.votes, "reminded"), MAX_VOTES);
  assert.equal(isStaleTopic(ledger, now, 60), false);
  assert.ok(topicWeight(ledger, now, 90) > 0.9);
  for (let index = 0; index < 25; index++) recordTopicVote(ledger, "loaded", now.toISOString());
  assert.equal(kinds(ledger.topic.votes, "loaded"), MAX_VOTES);
  assert.equal(kinds(ledger.topic.votes, "reminded"), MAX_VOTES);
  const reloaded = parseLedger(JSON.stringify(ledger));
  assert.deepEqual(reloaded.topic.votes, ledger.topic.votes);
  const crowded = parseLedger(
    JSON.stringify({
      topic: {
        votes: [
          { kind: "loaded", ts: loadedAt.toISOString() },
          ...Array.from({ length: 30 }, () => ({ kind: "reminded", ts: now.toISOString() })),
        ],
      },
    }),
  );
  assert.equal(kinds(crowded.topic.votes, "loaded"), 1);
  assert.equal(kinds(crowded.topic.votes, "reminded"), MAX_VOTES);
  assert.equal(isStaleTopic({ ...crowded, topic: { ...crowded.topic, created: ledger.topic.created } }, now, 60), false);
});

test("saves and loads ledgers, tolerating missing or malformed files", () => {
  const dir = mkdtempSync(join(tmpdir(), "psm-ledger-"));
  const path = join(dir, "topic", "ledger.json");
  assert.deepEqual(loadLedger(path), emptyLedger());
  const ledger = emptyLedger("2025-01-01");
  mintId(ledger, "s", now);
  recordVote(ledger, "r1", "confirmed", now);
  recordTopicVote(ledger, "reminded", now.toISOString());
  saveLedger(path, ledger);
  assert.deepEqual(loadLedger(path), ledger);
  assert.deepEqual(JSON.parse(readFileSync(path, "utf8")).topic.created, "2025-01-01");
  assert.deepEqual(parseLedger("{oops"), emptyLedger());
  const filtered = parseLedger(
    JSON.stringify({ memories: { r1: { votes: [{ kind: "bogus", ts: "x" }, { kind: "applied", ts: "t" }] }, bad: {} } }),
  );
  assert.deepEqual(Object.keys(filtered.memories), ["r1"]);
  assert.deepEqual(filtered.memories.r1!.votes, [{ kind: "applied", ts: "t" }]);
});

test("every memory carries an origin, and ledgers written before origin existed read as human", () => {
  const old = parseLedger(JSON.stringify({ nextId: 3, memories: { r1: { source: "a", learned: "2025-01-01", votes: [] }, r2: { source: "b", learned: "2025-01-02", origin: "bogus" } } }));
  assert.equal(old.memories.r1!.origin, "human");
  assert.equal(old.memories.r2!.origin, "human");
  const observed = parseLedger(JSON.stringify({ nextId: 2, memories: { r1: { source: "a", learned: "2025-01-01", origin: "observed" } } }));
  assert.equal(observed.memories.r1!.origin, "observed");
  assert.equal(parseLedger(JSON.stringify(observed)).memories.r1!.origin, "observed");
});
