import { strict as assert } from "node:assert";
import { test } from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveConfig } from "../src/config.ts";
import { runSelector, selectedTopics, selectorPrompt } from "../src/selector.ts";
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

test("selector completes in process through the configured model registry with cancellation", async () => {
  const controller = new AbortController();
  const model = { id: "fast" };
  const ctx = { modelRegistry: {
    find: (provider: string, id: string) => {
      assert.equal(provider, "tier");
      assert.equal(id, "fast");
      return model;
    },
    complete: async (chosen: unknown, context: { messages: { content: string }[] }, options: { signal: AbortSignal }) => {
      assert.equal(chosen, model);
      assert.equal(context.messages[0].content, "select");
      assert.equal(options.signal, controller.signal);
      return { stopReason: "stop", content: [{ type: "text", text: '["one"]' }] };
    },
  } } as unknown as ExtensionContext;
  assert.equal(await runSelector("select", ctx, resolveConfig({}), controller.signal), '["one"]');
});
