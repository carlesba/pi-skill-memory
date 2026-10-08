import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { readSkillIndex, skillIndexRoots } from "../src/skill-index.ts";

function file(path: string, content: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
}

test("lists skill roots in pi's discovery order", () => {
  assert.deepEqual(skillIndexRoots({ agentDir: "/a", home: "/h", cwd: "/c" }), [
    "/a/skills",
    "/h/.agents/skills",
    "/c/.pi/skills",
    "/c/.agents/skills",
  ]);
});

test("indexes hand-written skills tolerantly and excludes the memory dir", () => {
  const base = mkdtempSync(join(tmpdir(), "psm-skills-"));
  const root = join(base, "skills");
  const memoryDir = join(base, "memory");
  file(join(root, "folded", "SKILL.md"), "---\nname: folded\ndescription: >\n  Use when\n  folding.\n---\nbody");
  file(join(root, "quoted", "SKILL.md"), "---\ndescription: 'Quoted one'\n---\n");
  file(join(root, "group", "nested", "SKILL.md"), "---\nname: nested\ndescription: Nested skill\n---\n");
  file(join(root, "group", "stray.md"), "---\nname: stray\ndescription: not at root\n---\n");
  file(join(root, "standalone.md"), "---\ndescription: |\n  Literal\n  text\n---\n");
  file(join(root, "nodesc", "SKILL.md"), "---\nname: nodesc\n---\n");
  file(join(root, ".hidden", "SKILL.md"), "---\nname: hidden\ndescription: h\n---\n");
  file(join(memoryDir, "memory-skills", "mem-any-x", "SKILL.md"), "---\nname: mem-any-x\ndescription: m\n---\n");
  symlinkSync(join(memoryDir, "memory-skills"), join(root, "linked-memory"));
  symlinkSync(join(root, "folded"), join(root, "zz-duplicate"));

  const index = readSkillIndex([root, join(base, "missing")], memoryDir);
  assert.deepEqual(
    index.map(({ name, description }) => ({ name, description })),
    [
      { name: "folded", description: "Use when folding." },
      { name: "nested", description: "Nested skill" },
      { name: "quoted", description: "Quoted one" },
      { name: "standalone", description: "Literal text" },
    ],
  );
});
