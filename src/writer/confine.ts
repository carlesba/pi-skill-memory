import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { MAX_SKILL_NAME_LENGTH, MEMORY_SKILLS_DIR } from "../topics.ts";

export class ConfinementError extends Error {}

const TOPIC_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isInside(path: string, directory: string): boolean {
  const rel = relative(directory, path);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

function existing(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export function confinedPath(dir: string, relativePath: string): string {
  if (relativePath === "" || isAbsolute(relativePath)) {
    throw new ConfinementError(`path must be relative to the memory dir: ${relativePath}`);
  }
  const segments = relativePath.split(/[\\/]+/);
  if (segments.some((segment) => segment === ".." || segment === "." || segment === "")) {
    throw new ConfinementError(`path escapes the memory dir: ${relativePath}`);
  }
  const root = resolve(dir);
  const target = resolve(root, relativePath);
  if (!isInside(target, root) || target === root) {
    throw new ConfinementError(`path escapes the memory dir: ${relativePath}`);
  }
  if (!existing(root)) return target;
  const realRoot = realpathSync(root);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    if (!existing(current)) break;
    const real = realpathSync(current);
    if (!isInside(real, realRoot)) {
      throw new ConfinementError(`path resolves outside the memory dir: ${relativePath}`);
    }
  }
  return target;
}

export function isValidTopicName(name: string): boolean {
  return name.length <= MAX_SKILL_NAME_LENGTH && TOPIC_NAME.test(name);
}

export function confinedTopicPath(dir: string, name: string, file?: string): string {
  if (!isValidTopicName(name)) throw new ConfinementError(`invalid topic name: ${name}`);
  const parts = [MEMORY_SKILLS_DIR, name];
  if (file !== undefined) parts.push(file);
  return confinedPath(dir, parts.join(sep));
}
