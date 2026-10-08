import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

const PATH_ARG_TOOLS = new Set(["read", "edit", "write", "grep", "find", "ls"]);
const SHELL_SEPARATORS = new Set([";", "&&", "||", "|", "&", "(", ")", "{", "}"]);

function normalizeToolPath(raw: string, cwd: string, home: string): string | null {
  let path = raw.trim();
  if (path.startsWith("@")) path = path.slice(1);
  if (path === "") return null;
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  if (isAbsolute(path)) return resolve(path);
  return resolve(cwd, path);
}

export function tokenizeShell(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  let hasToken = false;
  let quote: "'" | '"' | null = null;
  const push = () => {
    if (hasToken) tokens.push(current);
    current = "";
    hasToken = false;
  };
  for (let index = 0; index < command.length; index++) {
    const char = command[index]!;
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === '"' && index + 1 < command.length) {
        current += command[++index];
      } else {
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      hasToken = true;
      continue;
    }
    if (char === "\\" && index + 1 < command.length) {
      current += command[++index];
      hasToken = true;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      continue;
    }
    if (";|&(){}<>".includes(char)) {
      push();
      const pair = command.slice(index, index + 2);
      if (pair === "&&" || pair === "||") {
        tokens.push(pair);
        index++;
      } else if (char !== "<" && char !== ">") {
        tokens.push(char);
      }
      continue;
    }
    current += char;
    hasToken = true;
  }
  push();
  return tokens;
}

function directoryTarget(raw: string, cwd: string, home: string): string | null {
  if (raw.startsWith("-") || raw.startsWith("$")) return null;
  return normalizeToolPath(raw, cwd, home);
}

function absoluteToken(token: string, home: string): string | null {
  const value = token.includes("=/") || token.includes("=~/") ? token.slice(token.indexOf("=") + 1) : token;
  if (value.startsWith("~/") || value === "~") return normalizeToolPath(value, "/", home);
  if (value.startsWith("/") && !value.startsWith("//")) return resolve(value);
  return null;
}

export function extractBashPaths(command: string, cwd: string, home: string = homedir()): string[] {
  const tokens = tokenizeShell(command);
  const paths: string[] = [];
  let commandStart = true;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index]!;
    if (SHELL_SEPARATORS.has(token)) {
      commandStart = true;
      continue;
    }
    const next = tokens[index + 1];
    if (commandStart && token === "cd" && next !== undefined && !SHELL_SEPARATORS.has(next)) {
      const target = directoryTarget(next, cwd, home);
      if (target) paths.push(target);
      index++;
      commandStart = false;
      continue;
    }
    if (token === "-C" && index > 0 && tokens[index - 1] === "git" && next !== undefined) {
      const target = directoryTarget(next, cwd, home);
      if (target) paths.push(target);
      index++;
      continue;
    }
    commandStart = false;
    const absolute = absoluteToken(token, home);
    if (absolute) paths.push(absolute);
  }
  return [...new Set(paths)];
}

export function extractToolPaths(
  toolName: string,
  input: unknown,
  cwd: string,
  home: string = homedir(),
): string[] {
  if (typeof input !== "object" || input === null) return [];
  const record = input as Record<string, unknown>;
  if (PATH_ARG_TOOLS.has(toolName)) {
    if (typeof record.path !== "string") return [];
    const path = normalizeToolPath(record.path, cwd, home);
    return path ? [path] : [];
  }
  if (toolName === "bash" && typeof record.command === "string") {
    return extractBashPaths(record.command, cwd, home);
  }
  return [];
}
