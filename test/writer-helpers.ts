import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { RepoResolver } from "../src/repo.ts";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

export function writeFixtureSession(target: string, values: { cwd: string; dir: string }): string {
  const raw = readFileSync(join(FIXTURES, "session.jsonl"), "utf8")
    .replaceAll("__CWD__", values.cwd)
    .replaceAll("__MEMORY_DIR__", values.dir);
  writeFileSync(target, raw);
  return target;
}

export function fakeResolver(identities: Record<string, string>): RepoResolver {
  const lookup = (path: string) => {
    const root = Object.keys(identities).find((candidate) => path === candidate || path.startsWith(`${candidate}/`));
    return root ? { root, identity: identities[root]! } : null;
  };
  return { resolveDirectory: lookup, resolvePath: lookup };
}
