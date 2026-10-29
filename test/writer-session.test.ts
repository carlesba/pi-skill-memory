import { strict as assert } from "node:assert";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { MAX_USER_MESSAGE_CHARS, parseSession, readSession } from "../src/writer/session.ts";
import { fakeResolver, writeFixtureSession } from "./writer-helpers.ts";

test("reads user messages, final assistant texts, touched repos and memory reads from the active branch", () => {
  const root = mkdtempSync(join(tmpdir(), "psm-session-"));
  const cwd = join(root, "work", "app");
  const dir = join(root, "memory");
  const file = writeFixtureSession(join(root, "session.jsonl"), { cwd, dir });
  const digest = readSession(file, { dir, resolver: fakeResolver({ [join(root, "work", "app")]: "acme/app", [dir]: "me/memory" }) });
  assert.equal(digest.sessionId, "sess-1");
  assert.equal(digest.cwd, cwd);
  assert.deepEqual(
    digest.turns.map((turn) => turn.user),
    [
      "Add a test for the parser. Use node:test, never vitest, in every repo.",
      "No, I said node:test. Also forget the rule about snapshot files, I no longer want that.",
      "Thanks, that works.",
    ],
  );
  assert.deepEqual(
    digest.turns.map((turn) => turn.human),
    [true, true, true],
  );
  assert.deepEqual(
    digest.turns.map((turn) => turn.assistant),
    ["Added test/parser.test.ts using vitest.", "Switched to node:test.", "Done."],
  );
  assert.deepEqual(digest.repos, ["acme/app"]);
  assert.deepEqual(digest.memoryReads, ["mem-any-testing"]);
});

test("truncates long user and assistant texts", () => {
  const lines = [
    JSON.stringify({ type: "session", id: "s", cwd: "/w" }),
    JSON.stringify({ type: "message", id: "a", parentId: null, message: { role: "user", content: "u".repeat(5000) } }),
    JSON.stringify({ type: "message", id: "b", parentId: "a", message: { role: "assistant", content: [{ type: "text", text: "a".repeat(5000) }] } }),
    "not json",
  ];
  const digest = parseSession(lines.join("\n"), { dir: "/m", resolver: fakeResolver({}) });
  assert.equal(digest.turns[0]!.user.length, MAX_USER_MESSAGE_CHARS);
  assert.equal(digest.turns[0]!.assistant!.length, 1500);
});

test("marks a user message human only when an input mark from an allowed source names its timestamp", () => {
  const mark = (id: string, parentId: string | null, messageTimestamp: number, source: string, mode = "tui") =>
    JSON.stringify({ type: "custom", customType: "pi-skill-memory-input", id, parentId, data: { messageTimestamp, source, mode } });
  const user = (id: string, parentId: string, text: string, timestamp: number) =>
    JSON.stringify({ type: "message", id, parentId, message: { role: "user", content: text, timestamp } });
  const lines = [
    JSON.stringify({ type: "session", id: "s", cwd: "/w" }),
    mark("c1", null, 10, "interactive"),
    user("u1", "c1", "typed", 10),
    mark("c2", "u1", 20, "extension"),
    user("u2", "c2", "brief from a parent agent", 20),
    mark("c3", "u2", 30, "rpc", "rpc"),
    user("u3", "c3", "rpc prompt", 30),
    mark("c4", "u3", 40, "interactive", "print"),
    user("u4", "c4", "print mode prompt", 40),
    user("u5", "u4", "no mark at all", 50),
  ];
  const raw = lines.join("\n");
  const human = (learnFromSources?: ("interactive" | "rpc" | "extension")[]) =>
    parseSession(raw, { dir: "/m", resolver: fakeResolver({}), learnFromSources }).turns.map((turn) => turn.human);
  assert.deepEqual(human(), [true, false, false, false, false]);
  assert.deepEqual(human(["interactive", "rpc"]), [true, false, true, false, false]);
  assert.deepEqual(human([]), [false, false, false, false, false]);
});

test("persisted completed checkpoints survive resume and queued checkpoints alone do not consume turns", () => {
  const entries = [
    { type: "session", id: "session", cwd: "/work" },
    { type: "custom", id: "mark", parentId: null, customType: "pi-skill-memory-input", data: { messageTimestamp: 1, source: "interactive", mode: "tui" } },
    { type: "message", id: "user", parentId: "mark", message: { role: "user", content: "Remember this lesson", timestamp: 1 } },
    { type: "message", id: "assistant", parentId: "user", message: { role: "assistant", content: "Understood" } },
    { type: "custom", id: "checkpoint", parentId: "assistant", customType: "pi-skill-memory-watermark", data: { queuedThrough: "assistant", processedEntryIds: [] as string[] } },
  ];
  const parse = () => parseSession(entries.map((entry) => JSON.stringify(entry)).join("\n"), { dir: "/memory", resolver: fakeResolver({}) });
  assert.equal(parse().turns.filter((turn) => turn.human).length, 1);
  entries.at(-1)!.data!.processedEntryIds = ["assistant"];
  assert.equal(parse().turns.filter((turn) => turn.human).length, 0);
  assert.equal(parse().turns[0]!.assistant, "Understood");
  assert.equal(parse().turns[0]!.contextOnly, true);
});
