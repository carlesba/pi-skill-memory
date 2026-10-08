import { strict as assert } from "node:assert";
import { test } from "node:test";
import { parseFrontmatter, quoteScalar, splitFrontmatter } from "../src/frontmatter.ts";

test("reads plain, double-quoted and single-quoted scalars", () => {
  const parsed = parseFrontmatter(
    "---\nname: my-skill\ndescription: \"Use when: things \\\"quoted\\\"\"\nother: 'it''s fine'\n---\nBody\n",
  );
  assert.ok(parsed);
  assert.equal(parsed.fields.name, "my-skill");
  assert.equal(parsed.fields.description, 'Use when: things "quoted"');
  assert.equal(parsed.fields.other, "it's fine");
  assert.equal(parsed.body, "Body\n");
});

test("reads folded and literal block scalars", () => {
  const parsed = parseFrontmatter(
    "---\nname: x\ndescription: >\n  Use this when\n  writing tests.\nnotes: |\n  line one\n  line two\n---\n",
  );
  assert.ok(parsed);
  assert.equal(parsed.fields.description, "Use this when writing tests.");
  assert.equal(parsed.fields.notes, "line one\nline two");
});

test("joins plain multi-line continuations", () => {
  const parsed = parseFrontmatter("---\ndescription: first part\n  second part\n---\n");
  assert.equal(parsed?.fields.description, "first part second part");
});

test("reads one level of nested maps", () => {
  const parsed = parseFrontmatter(
    "---\nname: mem-any-x\nmetadata:\n  scope: \"repo:preply/apollo\"\n  updated: 2025-01-02\n---\nText ^r1\n",
  );
  assert.ok(parsed);
  assert.deepEqual(parsed.maps.metadata, { scope: "repo:preply/apollo", updated: "2025-01-02" });
  assert.equal(parsed.body, "Text ^r1\n");
});

test("tolerates CRLF, BOM and missing frontmatter", () => {
  assert.equal(parseFrontmatter("\uFEFF---\r\nname: a\r\n---\r\nb")?.fields.name, "a");
  assert.equal(parseFrontmatter("no frontmatter"), null);
  assert.equal(parseFrontmatter("---\nname: a\n"), null);
  assert.deepEqual(splitFrontmatter("---\n---\n"), { frontmatter: "", body: "" });
});

test("quoteScalar round-trips through the reader", () => {
  const value = 'When "editing": #1 thing\'s \\ path';
  const parsed = parseFrontmatter(`---\ndescription: ${quoteScalar(value)}\n---\n`);
  assert.equal(parsed?.fields.description, value);
});
