import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, isAbsolute } from "node:path";
import { parseFrontmatter } from "./frontmatter.ts";

export interface SkillIndexEntry {
  name: string;
  description: string;
  path: string;
}

export interface SkillIndexRootsInput {
  agentDir: string;
  home: string;
  cwd: string;
}

export function skillIndexRoots(input: SkillIndexRootsInput): string[] {
  return [
    join(input.agentDir, "skills"),
    join(input.home, ".agents", "skills"),
    join(input.cwd, ".pi", "skills"),
    join(input.cwd, ".agents", "skills"),
  ];
}

function realpathOrNull(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

function isInside(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function statKind(path: string): "file" | "directory" | null {
  try {
    const stats = statSync(path);
    if (stats.isDirectory()) return "directory";
    if (stats.isFile()) return "file";
    return null;
  } catch {
    return null;
  }
}

function readSkill(path: string, fallbackName: string): SkillIndexEntry | null {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseFrontmatter(raw);
  const description = parsed?.fields.description?.replace(/\s+/g, " ").trim();
  if (!description) return null;
  const name = parsed?.fields.name?.trim() || fallbackName;
  return { name, description, path };
}

export function readSkillIndex(roots: string[], excludeDir: string): SkillIndexEntry[] {
  const excluded = realpathOrNull(excludeDir) ?? excludeDir;
  const visited = new Set<string>();
  const entries: SkillIndexEntry[] = [];

  function add(path: string, fallbackName: string) {
    const real = realpathOrNull(path);
    if (!real || visited.has(real) || isInside(real, excluded)) return;
    visited.add(real);
    const skill = readSkill(path, fallbackName);
    if (skill) entries.push(skill);
  }

  function walk(directory: string, isRoot: boolean) {
    const real = realpathOrNull(directory);
    if (!real || isInside(real, excluded) || visited.has(`dir:${real}`)) return;
    visited.add(`dir:${real}`);
    const skillFile = join(directory, "SKILL.md");
    if (statKind(skillFile) === "file") {
      add(skillFile, basename(dirname(skillFile)));
      return;
    }
    let children: string[];
    try {
      children = readdirSync(directory).sort();
    } catch {
      return;
    }
    for (const child of children) {
      if (child.startsWith(".") || child === "node_modules") continue;
      const childPath = join(directory, child);
      const kind = statKind(childPath);
      if (kind === "directory") walk(childPath, false);
      else if (kind === "file" && isRoot && child.endsWith(".md")) add(childPath, child.slice(0, -3));
    }
  }

  for (const root of roots) walk(root, true);
  return entries;
}
