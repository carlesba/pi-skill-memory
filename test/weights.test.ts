import { strict as assert } from "node:assert";
import { test } from "node:test";
import { emptyLedger, type Ledger } from "../src/ledger.ts";
import {
  closestTopic,
  decayedWeight,
  isScopeAtCap,
  isStaleTopic,
  jaccard,
  memoryWeight,
  selectMemoryEvictions,
  selectSizeEvictions,
  selectStaleTopics,
  selectTopicEvictions,
  tokenize,
  topicWeight,
} from "../src/weights.ts";

const now = new Date("2025-06-01T00:00:00Z");
const settings = { halfLifeDays: 90, protectNewDays: 30, staleTopicDays: 60 };

function daysAgo(days: number): string {
  return new Date(now.getTime() - days * 86_400_000).toISOString();
}

function close(actual: number, expected: number) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ≉ ${expected}`);
}

test("decays votes by half-life with signed values", () => {
  close(decayedWeight([{ kind: "applied", ts: daysAgo(0) }], now, 90), 1);
  close(decayedWeight([{ kind: "applied", ts: daysAgo(90) }], now, 90), 0.5);
  close(decayedWeight([{ kind: "confirmed", ts: daysAgo(180) }], now, 90), 0.25);
  close(decayedWeight([{ kind: "contradicted", ts: daysAgo(90) }], now, 90), -1);
  close(decayedWeight([{ kind: "ignored", ts: daysAgo(0) }, { kind: "reminded", ts: daysAgo(0) }], now, 90), 1);
  close(decayedWeight([{ kind: "applied", ts: "garbage" }], now, 90), 0);
  close(memoryWeight(undefined, now, 90), 0);
});

test("topic weight adds decayed loaded votes to its memories' weights", () => {
  const ledger: Ledger = {
    nextId: 3,
    topic: {
      votes: [
        { kind: "loaded", ts: daysAgo(90) },
        { kind: "reminded", ts: daysAgo(0) },
      ],
    },
    memories: {
      r1: { source: "s", origin: "human", learned: daysAgo(100), votes: [{ kind: "applied", ts: daysAgo(0) }] },
      r2: { source: "s", origin: "human", learned: daysAgo(100), votes: [{ kind: "contradicted", ts: daysAgo(0) }] },
    },
  };
  close(topicWeight(ledger, now, 90), 0.5 + 1 - 2);
});

function ledgerWith(memories: Record<string, { learnedDaysAgo: number; applied: number[] }>): Ledger {
  const ledger = emptyLedger();
  for (const [id, spec] of Object.entries(memories)) {
    ledger.memories[id] = {
      source: "s",
      origin: "human",
      learned: daysAgo(spec.learnedDaysAgo).slice(0, 10),
      votes: spec.applied.map((age) => ({ kind: "applied" as const, ts: daysAgo(age) })),
    };
  }
  return ledger;
}

test("evicts lowest-weight memories first only above the cap", () => {
  const ledger = ledgerWith({
    r1: { learnedDaysAgo: 200, applied: [0, 0] },
    r2: { learnedDaysAgo: 200, applied: [] },
    r3: { learnedDaysAgo: 200, applied: [0] },
    r4: { learnedDaysAgo: 300, applied: [] },
  });
  const ids = ["r1", "r2", "r3", "r4"];
  assert.deepEqual(selectMemoryEvictions(ledger, ids, 4, now, settings), []);
  assert.deepEqual(selectMemoryEvictions(ledger, ids, 3, now, settings), ["r4"]);
  assert.deepEqual(selectMemoryEvictions(ledger, ids, 2, now, settings), ["r4", "r2"]);
  assert.deepEqual(selectMemoryEvictions(ledger, ids, 1, now, settings), ["r4", "r2", "r3"]);
});

test("never evicts memories younger than protectNewDays, keeping over cap if all are protected", () => {
  const ledger = ledgerWith({
    r1: { learnedDaysAgo: 200, applied: [0, 0, 0] },
    r2: { learnedDaysAgo: 5, applied: [] },
    r3: { learnedDaysAgo: 200, applied: [0] },
  });
  assert.deepEqual(selectMemoryEvictions(ledger, ["r1", "r2", "r3"], 2, now, settings), ["r3"]);
  assert.deepEqual(selectMemoryEvictions(ledger, ["r1", "r2", "r3"], 0, now, settings), ["r3", "r1"]);
  const fresh = ledgerWith({ r1: { learnedDaysAgo: 1, applied: [] }, r2: { learnedDaysAgo: 2, applied: [] } });
  assert.deepEqual(selectMemoryEvictions(fresh, ["r1", "r2"], 1, now, settings), []);
  assert.deepEqual(selectMemoryEvictions(fresh, ["r1", "r2", "r9"], 2, now, settings), ["r9"]);
});

test("evicts by size lowest weight first, skipping protected memories, and reports when it cannot fit", () => {
  const ledger = ledgerWith({
    r1: { learnedDaysAgo: 200, applied: [0] },
    r2: { learnedDaysAgo: 200, applied: [] },
    r3: { learnedDaysAgo: 5, applied: [] },
  });
  const memories = [
    { id: "r1", text: "Be terse." },
    { id: "r2", text: "Use tabs." },
    { id: "r3", text: "Prefer small PRs." },
  ];
  assert.deepEqual(selectSizeEvictions(ledger, memories, 100, now, settings), { evicted: [], memories, fits: true });
  const one = selectSizeEvictions(ledger, memories, 40, now, settings);
  assert.deepEqual(one.evicted, ["r2"]);
  assert.deepEqual(one.memories.map((memory) => memory.id), ["r1", "r3"]);
  assert.equal(one.fits, true);
  const stuck = selectSizeEvictions(ledger, memories, 10, now, settings);
  assert.deepEqual(stuck.evicted, ["r2", "r1"]);
  assert.equal(stuck.fits, false);
});

test("evicts topics per scope cap, lowest weight first, skipping new topics", () => {
  const topicLedger = (createdDaysAgo: number, loaded: number): Ledger => ({
    nextId: 1,
    topic: { created: daysAgo(createdDaysAgo), votes: Array.from({ length: loaded }, () => ({ kind: "loaded" as const, ts: daysAgo(0) })) },
    memories: {},
  });
  const topics = [
    { name: "mem-any-a", scope: "generic" as const, ledger: topicLedger(200, 3) },
    { name: "mem-any-b", scope: "generic" as const, ledger: topicLedger(200, 1) },
    { name: "mem-any-c", scope: "generic" as const, ledger: topicLedger(3, 0) },
    { name: "mem-apollo-x", scope: "repo:preply/apollo" as const, ledger: topicLedger(200, 0) },
    { name: "mem-apollo-y", scope: "repo:preply/apollo" as const, ledger: topicLedger(200, 2) },
  ];
  assert.deepEqual(selectTopicEvictions(topics, { maxGenericTopics: 3, maxTopicsPerRepo: 2 }, now, settings), []);
  assert.deepEqual(selectTopicEvictions(topics, { maxGenericTopics: 2, maxTopicsPerRepo: 1 }, now, settings), [
    "mem-any-b",
    "mem-apollo-x",
  ]);
  assert.deepEqual(selectTopicEvictions(topics, { maxGenericTopics: 0, maxTopicsPerRepo: 2 }, now, settings), [
    "mem-any-b",
    "mem-any-a",
  ]);
  assert.equal(isScopeAtCap(topics, "generic", { maxGenericTopics: 3, maxTopicsPerRepo: 8 }), true);
  assert.equal(isScopeAtCap(topics, "repo:preply/apollo", { maxGenericTopics: 3, maxTopicsPerRepo: 8 }), false);
});

test("closest topic uses word-token Jaccard and breaks ties by weight", () => {
  assert.equal(jaccard(tokenize("a b c"), tokenize("b c d")), 0.5);
  assert.equal(jaccard(new Set(), new Set()), 0);
  const topics = [
    { name: "mem-apollo-state", description: "When changing state management stores", weight: 1 },
    { name: "mem-apollo-routing", description: "When adding routes", weight: 5 },
  ];
  assert.equal(closestTopic("Prefer zustand stores for state management", topics)?.name, "mem-apollo-state");
  const tie = closestTopic("unrelated words", topics);
  assert.deepEqual(tie, { name: "mem-apollo-routing", similarity: 0 });
  assert.equal(closestTopic("x", []), null);
});

test("detects stale topics by last loaded vote and creation age, lowest weight first", () => {
  const stale = (created: number, loaded: number[]): Ledger => ({
    nextId: 1,
    topic: { created: daysAgo(created), votes: loaded.map((age) => ({ kind: "loaded" as const, ts: daysAgo(age) })) },
    memories: {},
  });
  assert.equal(isStaleTopic(stale(100, []), now, 60), true);
  assert.equal(isStaleTopic(stale(100, [70, 80]), now, 60), true);
  assert.equal(isStaleTopic(stale(100, [10]), now, 60), false);
  assert.equal(isStaleTopic(stale(30, []), now, 60), false);
  assert.equal(isStaleTopic(emptyLedger(), now, 60), false);
  const topics = ["a", "b", "c", "d", "e"].map((name, index) => ({
    name,
    scope: "generic" as const,
    ledger: stale(100, Array.from({ length: 5 - index }, () => 61)),
  }));
  topics.push({ name: "fresh", scope: "generic", ledger: stale(100, [1]) });
  assert.deepEqual(selectStaleTopics(topics, now, settings), ["e", "d", "c"]);
});
