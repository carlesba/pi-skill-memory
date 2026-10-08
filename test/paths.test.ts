import { strict as assert } from "node:assert";
import { test } from "node:test";
import { extractBashPaths, extractToolPaths, tokenizeShell } from "../src/paths.ts";

const home = "/home/me";

test("path-arg tools resolve relative paths against cwd and expand ~ and @", () => {
  assert.deepEqual(extractToolPaths("read", { path: "src/a.ts" }, "/w/apollo", home), ["/w/apollo/src/a.ts"]);
  assert.deepEqual(extractToolPaths("edit", { path: "/abs/b.ts" }, "/w", home), ["/abs/b.ts"]);
  assert.deepEqual(extractToolPaths("write", { path: "~/notes.md" }, "/w", home), ["/home/me/notes.md"]);
  assert.deepEqual(extractToolPaths("grep", { pattern: "x", path: "@lib" }, "/w", home), ["/w/lib"]);
  assert.deepEqual(extractToolPaths("find", { pattern: "*.ts" }, "/w", home), []);
  assert.deepEqual(extractToolPaths("ls", { path: "../other" }, "/w/apollo", home), ["/w/other"]);
});

test("unknown tools and malformed input yield nothing", () => {
  assert.deepEqual(extractToolPaths("custom", { path: "/x" }, "/w", home), []);
  assert.deepEqual(extractToolPaths("read", null, "/w", home), []);
  assert.deepEqual(extractToolPaths("bash", { command: 42 }, "/w", home), []);
});

test("bash picks absolute tokens, ~ tokens, cd targets and git -C targets", () => {
  assert.deepEqual(extractBashPaths("cat /w/apollo/a.ts src/rel.ts", "/w", home), ["/w/apollo/a.ts"]);
  assert.deepEqual(extractBashPaths("cd ../hermes && npm test", "/w/apollo", home), ["/w/hermes"]);
  assert.deepEqual(extractBashPaths("git -C sub/repo status", "/w", home), ["/w/sub/repo"]);
  assert.deepEqual(extractBashPaths("ls ~/code/x; cd ~", "/w", home), ["/home/me/code/x", "/home/me"]);
  assert.deepEqual(extractBashPaths("rg foo --glob=/w/a 'quoted /w/b' > /tmp/out", "/w", home), ["/w/a", "/tmp/out"]);
});

test("bash ignores flags, variables and repeated paths", () => {
  assert.deepEqual(extractBashPaths("cd -", "/w", home), []);
  assert.deepEqual(extractBashPaths("cd $HOME && cat /a /a", "/w", home), ["/a"]);
  assert.deepEqual(extractBashPaths("echo cd /x", "/w", home), ["/x"]);
});

test("tokenizer handles quotes, escapes and operators", () => {
  assert.deepEqual(tokenizeShell(`cd "/w/my repo" && echo 'a b'|wc`), ["cd", "/w/my repo", "&&", "echo", "a b", "|", "wc"]);
  assert.deepEqual(tokenizeShell("a\\ b;c"), ["a b", ";", "c"]);
});
