import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../src/config.ts";
import { runSelector, selectedTopics, selectorPrompt, topicDelivery } from "../src/selector.ts";
import type { TopicSummary } from "../src/topics.ts";

const candidates: TopicSummary[] = ["one", "two", "three", "four"].map((name) => ({ name, description: `Use ${name}`, scope: "generic", path: `/memory/${name}/SKILL.md`, updated: "" }));

test("selector validates names, deduplicates and caps picks at three", () => {
  assert.deepEqual(selectedTopics('["one","one","two","three","four"]', candidates).map((topic) => topic.name), ["one", "two", "three"]);
  assert.deepEqual(selectedTopics('["unknown"]', candidates), []);
  assert.throws(() => selectedTopics('[1]', candidates));
  assert.throws(() => selectedTopics('not JSON', candidates));
  const prompt = selectorPrompt("request", "x".repeat(3000), candidates);
  const data = JSON.parse(prompt.slice(prompt.indexOf("\n") + 1));
  assert.equal(data.previousAssistant.length, 2000);
  assert.deepEqual(Object.keys(data.candidates[0]), ["name", "description"]);
});

test("selector streams through the model registry so virtual tier models are routed, with cancellation", async () => {
  const controller = new AbortController();
  const model = { id: "fast" };
  const ctx = { modelRegistry: {
    find: (provider: string, id: string) => {
      assert.equal(provider, "tier");
      assert.equal(id, "fast");
      return model;
    },
    streamSimple: (chosen: unknown, context: { messages: { content: string }[] }, options: { signal: AbortSignal }) => {
      assert.equal(chosen, model);
      assert.equal(context.messages[0].content, "select");
      assert.equal(options.signal, controller.signal);
      return { result: async () => ({ stopReason: "stop", content: [{ type: "text", text: '["one"]' }] }) };
    },
  } } as unknown as ExtensionContext;
  assert.equal(await runSelector("select", ctx, resolveConfig({}), controller.signal), '["one"]');
});


test("selector includes examples after rules inside the shared character budget", () => {
  const path = join(mkdtempSync(join(tmpdir(), "psm-examples-")), "SKILL.md");
  writeFileSync(path, "---\nname: test\n---\nRule first. ^r1\n\n## Examples\n\nWorked example. ^r2\n");
  const topic = { ...candidates[0], path };
  const delivered = topicDelivery(topic, "inject", 1000);
  assert.ok(delivered.indexOf("Rule first") < delivered.indexOf("Worked example"));
  const budget = delivered.indexOf("## Examples");
  assert.equal(topicDelivery(topic, "inject", budget).length, budget);
  assert.doesNotMatch(topicDelivery(topic, "inject", budget), /Worked example/);
});
