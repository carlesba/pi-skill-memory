import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { resolveConfig } from "../src/config.ts";
import { parseFrontmatter } from "../src/frontmatter.ts";
import { readHistory } from "../src/history.ts";
import { formatStats } from "../src/stats.ts";
import { acquireLock } from "../src/writer/lock.ts";
import { parseRedescribeArgs, redescribe, replaceDescription } from "../src/writer/redescribe.ts";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "psm-redescribe-"));
  const config = resolveConfig({ memory: { dir: join(root, "memory"), stateDir: join(root, "state"), autoCommit: false } });
  const path = join(config.dir, "memory-skills", "mem-test", "SKILL.md");
  mkdirSync(join(path, ".."), { recursive: true });
  const raw = '---\r\nname: mem-test\r\ndescription: >-\r\n  Old description.\r\nmetadata:\r\n  scope: generic\r\n  updated: "2026-10-29"\r\n---\r\n\r\nRule with trailing spaces. ^r7  \r\n\r\n## Examples\r\n\r\nAccepted approach. ^r8\r\n';
  writeFileSync(path, raw);
  return { root, config, path, raw };
}

const answer = JSON.stringify({ description: 'Edit files or review changes in the "test" tool.' });

test("redescribe previews without persisted writes and rewrites only the description with history", async () => {
  const { config, path, raw } = fixture();
  const before = readdirSync(config.dir, { recursive: true });
  const model = async (prompt: string) => {
    assert.match(prompt, /words a user would type in a request/);
    assert.match(prompt, /at most 300 characters/);
    assert.match(prompt, /Accepted approach/);
    return answer;
  };
  const preview = await redescribe(config, { dryRun: true }, model);
  assert.match(preview, /Topic \| Before \| After/);
  assert.match(preview, /Old description/);
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.deepEqual(readdirSync(config.dir, { recursive: true }), before);
  assert.equal(existsSync(config.stateDir), false);
  await redescribe(config, { dryRun: false, topic: "mem-test" }, model, () => new Date("2026-10-29T12:00:00Z"));
  const updated = readFileSync(path, "utf8");
  assert.equal(updated, replaceDescription(raw, JSON.parse(answer).description));
  assert.equal(updated.slice(updated.indexOf("\r\n---\r\n")), raw.slice(raw.indexOf("\r\n---\r\n")));
  assert.equal(parseFrontmatter(updated)?.fields.description, JSON.parse(answer).description);
  assert.deepEqual(readHistory(config.stateDir, "descriptions"), [{ kind: "redescribed", topic: "mem-test", ts: "2026-10-29T12:00:00.000Z", oldDescription: "Old description.", newDescription: JSON.parse(answer).description }]);
  assert.match(formatStats(config, "2026-10-29"), /Redescribed events: 1/);
  assert.match(formatStats(config, "2026-10-30"), /Redescribed events: 0/);
  await redescribe(config, { dryRun: false }, model);
  assert.equal(readHistory(config.stateDir, "descriptions").length, 1);
});

test("redescribe rejects invalid outputs and unknown topics without changing files", async () => {
  for (const output of ['{}', 'null', '{"description":" "}', JSON.stringify({ description: "x".repeat(301) }), 'not json']) {
    const { config, path, raw } = fixture();
    await assert.rejects(redescribe(config, { dryRun: false }, async () => output));
    assert.equal(readFileSync(path, "utf8"), raw);
    assert.equal(existsSync(join(config.dir, ".writer.lock")), false);
    assert.equal(existsSync(config.stateDir), false);
  }
  const { config } = fixture();
  await assert.rejects(redescribe(config, { dryRun: false, topic: "../escape" }, async () => answer), /no topic/);
  assert.deepEqual(parseRedescribeArgs(["--topic", "mem-test", "--dry-run"]), { topic: "mem-test", dryRun: true });
  for (const args of [["--topic"], ["--topic", "--dry-run"], ["extra"], ["--dry-run", "--dry-run"]]) assert.throws(() => parseRedescribeArgs(args), /usage/);
});

test("redescribe waits for the writer lock before invoking the model", async () => {
  const { config } = fixture();
  const release = await acquireLock(config.dir);
  let invoked = false;
  const pending = redescribe(config, { dryRun: true }, async () => { invoked = true; return answer; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(invoked, false);
  release();
  await pending;
  assert.equal(invoked, true);
});

test("redescribe commits only selected topic files and leaves other staged work alone", async () => {
  const { config, path } = fixture();
  const git = (...args: string[]) => execFileSync("git", args, { cwd: config.dir, encoding: "utf8" }).trim();
  git("init", "-q");
  git("config", "user.name", "Carles Ballester");
  git("config", "user.email", "carlesba@users.noreply.github.com");
  git("config", "commit.gpgsign", "false");
  git("add", "memory-skills");
  git("commit", "-qm", "Initialize fixture");
  writeFileSync(join(config.dir, "unrelated"), "keep staged");
  git("add", "unrelated");
  await redescribe({ ...config, autoCommit: true }, { dryRun: false }, async () => answer);
  assert.match(git("log", "-1", "--format=%B"), /memory: redescribe topics\n\nmem-test/);
  assert.equal(git("diff", "--cached", "--name-only"), "unrelated");
  assert.equal(git("show", "--format=", "--name-only", "HEAD"), "memory-skills/mem-test/SKILL.md");
  assert.match(readFileSync(path, "utf8"), /Edit files/);
});

test("redescribe refuses topics symlinked outside the memory directory", async () => {
  const { root, config } = fixture();
  const external = join(root, "external");
  mkdirSync(external);
  writeFileSync(join(external, "SKILL.md"), '---\nname: mem-external\ndescription: Old\nmetadata:\n  scope: generic\n---\nBody\n');
  symlinkSync(external, join(config.dir, "memory-skills", "mem-external"));
  await assert.rejects(redescribe(config, { dryRun: false, topic: "mem-external" }, async () => answer), /outside/);
});

test("topic filtering leaves siblings alone and validates a whole batch before writes", async () => {
  const { config, path, raw } = fixture();
  const sibling = join(config.dir, "memory-skills", "mem-z", "SKILL.md");
  mkdirSync(join(sibling, ".."), { recursive: true });
  const siblingRaw = raw.replace("name: mem-test", "name: mem-z");
  writeFileSync(sibling, siblingRaw);
  let calls = 0;
  await assert.rejects(redescribe(config, { dryRun: false }, async () => ++calls === 1 ? answer : '{}'), /invalid description/);
  assert.equal(readFileSync(path, "utf8"), raw);
  assert.equal(readFileSync(sibling, "utf8"), siblingRaw);
  await redescribe(config, { dryRun: false, topic: "mem-test" }, async () => answer);
  assert.equal(readFileSync(sibling, "utf8"), siblingRaw);
  assert.equal(readHistory(config.stateDir, "descriptions").length, 1);
});

test("description replacement preserves BOM, block scalar blank lines and the exact body", () => {
  const raw = '\uFEFF---\nname: mem-test\ndescription: |\n  First line\n\n  Second line\nmetadata:\n  scope: generic\n---\n\nBody\r\n  \n';
  const updated = replaceDescription(raw, "Edit test files.");
  assert.equal(updated, '\uFEFF---\nname: mem-test\ndescription: "Edit test files."\nmetadata:\n  scope: generic\n---\n\nBody\r\n  \n');
});
