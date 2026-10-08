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
