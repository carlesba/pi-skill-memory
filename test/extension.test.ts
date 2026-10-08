import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import extension, { createExtension, USER_MEMORY_SECTION, type ExtensionDeps } from "../src/index.ts";
import { serializeTopic, topicSkillPath, type Scope } from "../src/topics.ts";
import { readUsageEvents } from "../src/usage.ts";
import type { WriterJob } from "../src/writer/job.ts";
import { appendRun } from "../src/writer/runs.ts";
import { fakeResolver } from "./writer-helpers.ts";

type Handler = (event: any, ctx: any) => unknown;

interface Fixture {
  root: string;
  dir: string;
  stateDir: string;
}

function makeFixture(topics: { name: string; scope: Scope; description: string }[]): Fixture {
  const root = mkdtempSync(join(tmpdir(), "psm-extension-"));
  const dir = join(root, "memory");
  const stateDir = join(root, "state");
  for (const topic of topics) {
    const path = topicSkillPath(dir, topic.name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      serializeTopic({ ...topic, updated: "2025-03-01", memories: [{ id: "r1", text: `A memory in ${topic.name}.` }] }),
    );
  }
  return { root, dir, stateDir };
}

const STANDARD_TOPICS: { name: string; scope: Scope; description: string }[] = [
  { name: "mem-any-react-components", scope: "generic", description: "When writing React components in any repo." },
  { name: "mem-apollo-state", scope: "repo:preply/apollo", description: "When changing state management in preply/apollo." },
  { name: "mem-apollo-abstractions", scope: "repo:preply/apollo", description: "When adding abstractions in preply/apollo." },
  { name: "mem-billing-db", scope: "repo:acme/billing", description: "When touching the database layer in acme/billing." },
  { name: "mem-ui-tokens", scope: "repo:acme/ui", description: "When editing design tokens in acme/ui." },
];

const RESOLVER = fakeResolver({
  "/work/apollo": "preply/apollo",
  "/work/billing": "acme/billing",
  "/work/ui": "acme/ui",
  "/work/plain": "someone/plain",
});

function harness(fixture: Fixture, options: { memory?: Record<string, unknown>; deps?: Partial<ExtensionDeps> } = {}) {
  const handlers = new Map<string, Handler[]>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  const jobs: WriterJob[] = [];
  const notes: { text: string; level: string }[] = [];
  const session = {
    id: "sess-1",
    file: join(fixture.root, "session.jsonl") as string | undefined,
    branch: [] as unknown[],
    leaf: "leaf-1" as string | null,
  };
  const pi = {
    on(event: string, handler: Handler) {
      handlers.set(event, [...(handlers.get(event) ?? []), handler]);
      return () => undefined;
    },
    registerCommand(name: string, command: { handler: (args: string, ctx: unknown) => Promise<void> }) {
      commands.set(name, command);
    },
    getSettings() {
      return { memory: { dir: fixture.dir, stateDir: fixture.stateDir, ...options.memory } };
    },
  };
  const ctx = (cwd = "/work/apollo") => ({
    cwd,
    hasUI: true,
    ui: { notify: (text: string, level = "info") => notes.push({ text, level }) },
    sessionManager: {
      getSessionId: () => session.id,
      getSessionFile: () => session.file,
      getBranch: () => session.branch,
      getLeafId: () => session.leaf,
    },
  });
  createExtension({
    resolver: RESOLVER,
    enqueue: (job) => {
      jobs.push(job);
      return { jobFile: join(fixture.stateDir, "jobs", "job.json"), runner: "detached" };
    },
    now: () => new Date("2025-03-01T12:00:00.000Z"),
    env: {},
    home: fixture.root,
    packageRoot: "/pkg",
    which: () => null,
    ...options.deps,
  })(pi as unknown as ExtensionAPI);
  async function fire(event: string, payload: Record<string, unknown>, context = ctx()): Promise<unknown> {
    let result: unknown;
    for (const handler of handlers.get(event) ?? []) result = await handler({ type: event, ...payload }, context);
    return result;
  }
  async function command(args: string, context = ctx()): Promise<string> {
    await commands.get("memory")!.handler(args, context);
    return notes.at(-1)?.text ?? "";
  }
  async function toolRound(id: string, toolName: string, input: Record<string, unknown>, context = ctx()) {
    await fire("tool_call", { toolCallId: id, toolName, input }, context);
    return (await fire(
      "tool_result",
      { toolCallId: id, toolName, input, content: [{ type: "text", text: "output" }], structuredContent: { ok: true }, isError: false },
      context,
    )) as { content: { type: string; text: string }[]; structuredContent: unknown } | undefined;
  }
  return { handlers, commands, jobs, notes, session, ctx, fire, command, toolRound };
}

function userMessages(count: number): unknown[] {
  return Array.from({ length: count }, (_value, index) => ({
    type: "message",
    id: `u${index}`,
    message: { role: "user", content: `message ${index}` },
  }));
}

test("the default export registers every handler and the memory command without side effects", () => {
  const events: string[] = [];
  const commands: string[] = [];
  const pi = {
    on: (event: string) => {
      events.push(event);
      return () => undefined;
    },
    registerCommand: (name: string) => commands.push(name),
    getSettings: () => {
      throw new Error("settings must not be read at load time");
    },
  };
  extension(pi as unknown as ExtensionAPI);
  assert.deepEqual(
    [...events].sort(),
    ["before_agent_start", "resources_discover", "session_compact", "session_shutdown", "session_start", "tool_call", "tool_result"],
  );
  assert.deepEqual(commands, ["memory"]);
});

test("resources_discover lists generic topics plus the cwd repo's topics and records why", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  const h = harness(fixture);
  await h.fire("session_start", { reason: "startup" });
  const result = (await h.fire("resources_discover", { cwd: "/work/apollo", reason: "startup" })) as { skillPaths: string[] };
  assert.deepEqual(
    [...result.skillPaths].sort(),
    ["mem-any-react-components", "mem-apollo-abstractions", "mem-apollo-state"].map((name) => topicSkillPath(fixture.dir, name)).sort(),
  );
  const explain = await h.command("explain");
  assert.match(explain, /mem-any-react-components: generic topic/);
  assert.match(explain, /mem-apollo-state: scoped to preply\/apollo, the repository containing \/work\/apollo/);
  assert.doesNotMatch(explain, /mem-billing-db/);

  const elsewhere = harness(fixture);
  await elsewhere.fire("session_start", { reason: "startup" }, elsewhere.ctx("/tmp/not-a-repo"));
  const generic = (await elsewhere.fire("resources_discover", { cwd: "/tmp/not-a-repo", reason: "startup" })) as { skillPaths: string[] };
  assert.deepEqual(generic.skillPaths, [topicSkillPath(fixture.dir, "mem-any-react-components")]);
});

test("/memory explain keeps reporting pi's listing after /new and /resume", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  const h = harness(fixture);
  await h.fire("session_start", { reason: "startup" });
  await h.fire("resources_discover", { cwd: "/work/apollo", reason: "startup" });
  for (const reason of ["new", "resume", "fork"]) {
    await h.fire("session_shutdown", { reason });
    h.session.id = `sess-${reason}`;
    await h.fire("session_start", { reason }, h.ctx("/work/billing"));
    const explain = await h.command("explain", h.ctx("/work/billing"));
    assert.match(explain, /mem-any-react-components: generic topic/, reason);
    assert.match(explain, /mem-apollo-state: scoped to preply\/apollo, the repository containing \/work\/apollo/, reason);
    assert.doesNotMatch(explain, /mem-billing-db/, reason);
  }
  await h.fire("session_shutdown", { reason: "reload" });
  await h.fire("session_start", { reason: "reload" }, h.ctx("/work/billing"));
  await h.fire("resources_discover", { cwd: "/work/billing", reason: "reload" }, h.ctx("/work/billing"));
  const reloaded = await h.command("explain", h.ctx("/work/billing"));
  assert.match(reloaded, /mem-billing-db: scoped to acme\/billing/);
  assert.doesNotMatch(reloaded, /mem-apollo-state/);
});

test("first-touch reminder fires once per repo per session and again after compaction", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  const h = harness(fixture);
  await h.fire("session_start", { reason: "startup" });

  const first = await h.toolRound("t1", "read", { path: "/work/billing/src/db.ts" });
  assert.equal(first!.content.length, 2);
  assert.equal(first!.content[0]!.text, "output");
  assert.match(first!.content[1]!.text, /^\[memory\] acme\/billing has memory skills: mem-billing-db — load the ones that apply/);
  assert.deepEqual(first!.structuredContent, { ok: true });

  assert.equal(await h.toolRound("t2", "bash", { command: "cd /work/billing && ls" }), undefined);
  assert.equal(await h.toolRound("t3", "ls", { path: "/work/plain" }), undefined);

  const apollo = await h.toolRound("t4", "grep", { path: "src", pattern: "x" });
  assert.match(apollo!.content[1]!.text, /preply\/apollo has memory skills: mem-apollo-abstractions, mem-apollo-state/);

  await h.fire("session_compact", { reason: "threshold" });
  const again = await h.toolRound("t5", "bash", { command: "git -C /work/billing status" });
  assert.match(again!.content[1]!.text, /acme\/billing has memory skills/);

  const explain = await h.command("explain");
  assert.match(explain, /acme\/billing \(mem-billing-db\): read touched \/work\/billing\/src\/db\.ts/);
  assert.match(explain, /acme\/billing \(mem-billing-db\): bash touched \/work\/billing/);

  const reminded = readUsageEvents(fixture.stateDir).filter((event) => event.kind === "reminded");
  assert.deepEqual(
    reminded.map((event) => event.topic),
    ["mem-billing-db", "mem-apollo-abstractions", "mem-apollo-state", "mem-billing-db"],
  );
  assert.ok(reminded.every((event) => event.session === "sess-1"));
});

test("reading a memory SKILL.md records one loaded event per topic and never triggers a reminder", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  const h = harness(fixture);
  await h.fire("session_start", { reason: "startup" });
  const path = topicSkillPath(fixture.dir, "mem-apollo-state");
  assert.equal(await h.toolRound("t1", "read", { path }), undefined);
  assert.equal(await h.toolRound("t2", "read", { path }), undefined);
  assert.equal(await h.toolRound("t3", "write", { path: topicSkillPath(fixture.dir, "mem-billing-db") }), undefined);
  assert.deepEqual(readUsageEvents(fixture.stateDir), [
    { ts: "2025-03-01T12:00:00.000Z", kind: "loaded", topic: "mem-apollo-state", session: "sess-1" },
  ]);
});

test("tool handlers never throw, even when repo resolution fails", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  const failing = {
    resolveDirectory: () => {
      throw new Error("git exploded");
    },
    resolvePath: () => {
      throw new Error("git exploded");
    },
  };
  const h = harness(fixture, { deps: { resolver: failing } });
  await h.fire("session_start", { reason: "startup" });
  assert.equal(await h.toolRound("t1", "read", { path: "/work/billing/a.ts" }), undefined);
  assert.equal(await h.fire("resources_discover", { cwd: "/work/apollo", reason: "startup" }), undefined);
});

test("a prompt naming a repo adds one reminder message, shared with the tool reminder set", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  const h = harness(fixture);
  await h.fire("session_start", { reason: "startup" });
  const options = () => ({ sections: {} as Record<string, string> });

  const named = (await h.fire("before_agent_start", { prompt: "Port the Apollo store to signals", systemPromptOptions: options() })) as {
    message: { customType: string; content: string; display: boolean };
  };
  assert.equal(named.message.customType, "pi-skill-memory-reminder");
  assert.match(named.message.content, /^\[memory\] preply\/apollo has memory skills: mem-apollo-abstractions, mem-apollo-state/);

  assert.equal(await h.fire("before_agent_start", { prompt: "and apollo again", systemPromptOptions: options() }), undefined);
  assert.equal(await h.toolRound("t1", "read", { path: "/work/apollo/src/store.ts" }), undefined);

  assert.equal(await h.fire("before_agent_start", { prompt: "the ui tweaks", systemPromptOptions: options() }), undefined);
  const full = (await h.fire("before_agent_start", { prompt: "check ACME/UI tokens", systemPromptOptions: options() })) as {
    message: { content: string };
  };
  assert.match(full.message.content, /acme\/ui has memory skills: mem-ui-tokens/);

  const explain = await h.command("explain");
  assert.match(explain, /preply\/apollo \(mem-apollo-abstractions, mem-apollo-state\): prompt mentioned "Apollo"/);
  assert.match(explain, /acme\/ui \(mem-ui-tokens\): prompt mentioned "ACME\/UI"/);
});

test("user.md is snapshotted at session start and injected identically on every turn", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  mkdirSync(fixture.dir, { recursive: true });
  writeFileSync(join(fixture.dir, "user.md"), "Prefer small PRs.\n");
  const h = harness(fixture);
  await h.fire("session_start", { reason: "startup" });
  const turns: Record<string, string>[] = [];
  for (const prompt of ["first", "second"]) {
    const systemPromptOptions = { sections: { other: "kept" } as Record<string, string> };
    await h.fire("before_agent_start", { prompt, systemPromptOptions });
    turns.push(systemPromptOptions.sections);
    writeFileSync(join(fixture.dir, "user.md"), "Changed mid-session.\n");
  }
  assert.equal(turns[0]!.other, "kept");
  assert.match(turns[0]![USER_MEMORY_SECTION]!, /Prefer small PRs\.$/);
  assert.equal(turns[0]![USER_MEMORY_SECTION], turns[1]![USER_MEMORY_SECTION]);

  const empty = makeFixture([]);
  const none = harness(empty);
  await none.fire("session_start", { reason: "startup" });
  const systemPromptOptions = { sections: {} as Record<string, string> };
  await none.fire("before_agent_start", { prompt: "hi", systemPromptOptions });
  assert.deepEqual(systemPromptOptions.sections, {});
});

test("session_shutdown enqueues a writer job only past minUserMessages and outside skip envs", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);

  const few = harness(fixture);
  await few.fire("session_start", { reason: "startup" });
  few.session.branch = userMessages(2);
  await few.fire("session_shutdown", { reason: "quit" });
  assert.equal(few.jobs.length, 0);

  const enough = harness(fixture);
  await enough.fire("session_start", { reason: "startup" });
  enough.session.branch = [...userMessages(3), { type: "message", id: "a1", message: { role: "assistant", content: [] } }];
  await enough.fire("session_shutdown", { reason: "quit" }, enough.ctx("/work/apollo/sub"));
  assert.equal(enough.jobs.length, 1);
  const job = enough.jobs[0]!;
  assert.equal(job.sessionFile, join(fixture.root, "session.jsonl"));
  assert.equal(job.sessionId, "sess-1");
  assert.equal(job.cwd, "/work/apollo/sub");
  assert.equal(job.packageRoot, "/pkg");
  assert.equal(job.force, false);
  assert.equal(job.createdAt, "2025-03-01T12:00:00.000Z");
  assert.equal(job.config.dir, fixture.dir);

  const lowered = harness(fixture, { memory: { minUserMessages: 1 } });
  await lowered.fire("session_start", { reason: "startup" });
  lowered.session.branch = userMessages(1);
  await lowered.fire("session_shutdown", { reason: "new" });
  assert.equal(lowered.jobs.length, 1);

  const nightshift = harness(fixture, { deps: { env: { NIGHTSHIFT_JOB: "1" } } });
  await nightshift.fire("session_start", { reason: "startup" });
  nightshift.session.branch = userMessages(5);
  await nightshift.fire("session_shutdown", { reason: "quit" });
  assert.equal(nightshift.jobs.length, 0);

  const custom = harness(fixture, { memory: { skipWriteWhenEnv: ["MY_BOT"] }, deps: { env: { MY_BOT: "yes", NIGHTSHIFT_JOB: "1" } } });
  await custom.fire("session_start", { reason: "startup" });
  custom.session.branch = userMessages(5);
  await custom.fire("session_shutdown", { reason: "quit" });
  assert.equal(custom.jobs.length, 0);

  const reload = harness(fixture);
  await reload.fire("session_start", { reason: "startup" });
  reload.session.branch = userMessages(5);
  await reload.fire("session_shutdown", { reason: "reload" });
  assert.equal(reload.jobs.length, 0);

  const ephemeral = harness(fixture);
  await ephemeral.fire("session_start", { reason: "startup" });
  ephemeral.session.branch = userMessages(5);
  ephemeral.session.file = undefined;
  await ephemeral.fire("session_shutdown", { reason: "quit" });
  assert.equal(ephemeral.jobs.length, 0);
});

test("/memory write enqueues a forced job now and shutdown does not repeat it for the same leaf", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  const h = harness(fixture);
  await h.fire("session_start", { reason: "startup" });
  h.session.branch = userMessages(5);
  const reply = await h.command("write");
  assert.match(reply, /Queued the memory writer for this session \(detached runner/);
  assert.equal(h.jobs.length, 1);
  assert.equal(h.jobs[0]!.force, true);
  await h.fire("session_shutdown", { reason: "quit" });
  assert.equal(h.jobs.length, 1);

  const later = harness(fixture);
  await later.fire("session_start", { reason: "startup" });
  later.session.branch = userMessages(5);
  await later.command("write");
  later.session.leaf = "leaf-2";
  await later.fire("session_shutdown", { reason: "quit" });
  assert.equal(later.jobs.length, 2);
  assert.equal(later.jobs[1]!.force, false);
});

test("/memory status reports the dir, topic counts per scope, the last run and the runner", async () => {
  const fixture = makeFixture(STANDARD_TOPICS);
  appendRun(fixture.stateDir, { ts: "2025-02-01T00:00:00.000Z", session: "old", outcome: "nothing", topics: [] });
  appendRun(fixture.stateDir, { ts: "2025-03-01T00:00:00.000Z", session: "s9", outcome: "ok", topics: ["mem-apollo-state"] });
  const h = harness(fixture, { memory: { runner: "pueue" } });
  await h.fire("session_start", { reason: "startup" });
  const status = await h.command("");
  assert.match(status, new RegExp(`memory dir: ${fixture.dir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
  assert.match(status, /topics: 5\n {2}generic: 1\n {2}repo:acme\/billing: 1\n {2}repo:acme\/ui: 1\n {2}repo:preply\/apollo: 2/);
  assert.match(status, /last writer run: ok at 2025-03-01T00:00:00.000Z for session s9, topics mem-apollo-state/);
  assert.match(status, /runner: pueue \(writers fall back to detached; pueue not on PATH\)/);

  const withPueue = harness(fixture, { deps: { which: () => "/usr/local/bin/pueue" } });
  await withPueue.fire("session_start", { reason: "startup" });
  assert.match(await withPueue.command("status"), /runner: detached \(pueue on PATH at \/usr\/local\/bin\/pueue\)/);
  assert.match(await withPueue.command("bogus"), /Unknown subcommand "bogus"/);
});
