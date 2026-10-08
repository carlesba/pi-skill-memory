import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

test("the writer entry point loads under plain node and requires a job file", () => {
  const main = fileURLToPath(new URL("../src/writer/main.ts", import.meta.url));
  const result = spawnSync(process.execPath, [main], { encoding: "utf8" });
  assert.equal(result.status, 2, result.stderr);
  assert.match(result.stderr, /usage: node src\/writer\/main\.ts <jobfile>/);
});
