import { strict as assert } from "node:assert";
import { test } from "node:test";
import { resolveConfig, shouldSkipWrite } from "../src/config.ts";

const home = "/home/me";

test("applies defaults when the memory key is missing", () => {
  const config = resolveConfig({}, { env: {}, home });
  assert.equal(config.agentDir, "/home/me/.pi/agent");
  assert.equal(config.dir, "/home/me/.pi/agent/memory");
  assert.equal(config.stateDir, "/home/me/.local/state/pi-skill-memory");
  assert.equal(config.runner, "detached");
  assert.equal(config.pueueGroup, "pi-skill-memory");
  assert.equal(config.writerModel, undefined);
  assert.equal(config.minUserMessages, 3);
  assert.equal(config.maxCharsPerTopic, 4000);
  assert.equal(config.maxMemoriesPerTopic, 12);
  assert.equal(config.maxGenericTopics, 10);
  assert.equal(config.maxTopicsPerRepo, 8);
  assert.equal(config.maxUserChars, 4000);
  assert.equal(config.halfLifeDays, 90);
  assert.equal(config.protectNewDays, 30);
  assert.equal(config.staleTopicDays, 60);
  assert.equal(config.autoCommit, true);
  assert.deepEqual(config.skipWriteWhenEnv, []);
  assert.deepEqual(config.learnFromSources, ["interactive"]);
});

test("honours PI_CODING_AGENT_DIR and XDG_STATE_HOME", () => {
  const config = resolveConfig(undefined, { env: { PI_CODING_AGENT_DIR: "/agent", XDG_STATE_HOME: "/state" }, home });
  assert.equal(config.dir, "/agent/memory");
  assert.equal(config.stateDir, "/state/pi-skill-memory");
});

test("reads overrides, expands ~ and ignores invalid values", () => {
  const config = resolveConfig(
    {
      memory: {
        dir: "~/notes/memory",
        stateDir: "~/state",
        writerModel: "anthropic/claude",
        runner: "pueue",
        maxMemoriesPerTopic: 5,
        halfLifeDays: "soon",
        autoCommit: false,
        skipWriteWhenEnv: ["CI", 3],
        learnFromSources: ["rpc", "interactive", "rpc", "typed", 4],
      },
    },
    { env: {}, home },
  );
  assert.equal(config.dir, "/home/me/notes/memory");
  assert.equal(config.stateDir, "/home/me/state");
  assert.equal(config.writerModel, "anthropic/claude");
  assert.equal(config.runner, "pueue");
  assert.equal(config.maxMemoriesPerTopic, 5);
  assert.equal(config.halfLifeDays, 90);
  assert.equal(config.autoCommit, false);
  assert.deepEqual(config.skipWriteWhenEnv, ["CI"]);
  assert.deepEqual(config.learnFromSources, ["rpc", "interactive"]);
  assert.deepEqual(resolveConfig({ memory: { learnFromSources: [] } }, { env: {}, home }).learnFromSources, []);
  assert.deepEqual(resolveConfig({ memory: { learnFromSources: "rpc" } }, { env: {}, home }).learnFromSources, ["interactive"]);
  assert.equal(resolveConfig({ memory: { runner: "cron" } }, { env: {}, home }).runner, "detached");
});

test("skipWrite fires on any configured env var and on none by default", () => {
  const defaults = resolveConfig({}, { env: {}, home });
  assert.equal(shouldSkipWrite(defaults, { NIGHTSHIFT_JOB: "1", PI_SUBAGENT_AGENT_ID: "a1" }), false);
  const config = resolveConfig({ memory: { skipWriteWhenEnv: ["MY_BOT", "MY_JOB"] } }, { env: {}, home });
  assert.equal(shouldSkipWrite(config, {}), false);
  assert.equal(shouldSkipWrite(config, { MY_JOB: "a1" }), true);
  assert.equal(shouldSkipWrite(config, { MY_BOT: "" }), false);
});
