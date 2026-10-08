import { strict as assert } from "node:assert";
import { spawn } from "node:child_process";
import { test } from "node:test";
import { createPiRunner, extractJson, ModelOutputError, type SpawnFunction } from "../src/writer/model.ts";

test("extracts JSON from bare, fenced and prefixed model output", () => {
  assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
  assert.deepEqual(extractJson('```json\n{"a":2}\n```'), { a: 2 });
  assert.deepEqual(extractJson('Here you go:\n```\n{"a":3}\n```\nDone'), { a: 3 });
  assert.deepEqual(extractJson('Sure. {"a":4} hope it helps'), { a: 4 });
  assert.throws(() => extractJson("nothing here"), ModelOutputError);
  assert.throws(() => extractJson("{broken"), ModelOutputError);
});

test("the pi runner passes the prompt on stdin with the writer flags and the model", async () => {
  const calls: { command: string; args: readonly string[] }[] = [];
  const fakeSpawn = ((command: string, args: readonly string[], options: object) => {
    calls.push({ command, args });
    return spawn(process.execPath, ["-e", "process.stdin.pipe(process.stdout)"], options);
  }) as unknown as SpawnFunction;
  const runner = createPiRunner({ model: "provider/model", spawn: fakeSpawn });
  assert.equal(await runner("the prompt"), "the prompt");
  assert.equal(calls[0]!.command, "pi");
  assert.deepEqual(calls[0]!.args, [
    "-p",
    "--no-extensions",
    "--no-tools",
    "--no-session",
    "--no-skills",
    "--no-context-files",
    "--model",
    "provider/model",
  ]);
  const noModel = createPiRunner({ spawn: fakeSpawn });
  await noModel("x");
  assert.ok(!calls[1]!.args.includes("--model"));
});

test("the pi runner rejects on a non-zero exit", async () => {
  const fakeSpawn = ((_command: string, _args: readonly string[], options: object) =>
    spawn(process.execPath, ["-e", "process.stdin.resume(); process.stdin.on('end', () => { console.error('boom'); process.exit(3); })"], options)) as unknown as SpawnFunction;
  await assert.rejects(createPiRunner({ spawn: fakeSpawn })("x"), /exited with 3: boom/);
});
