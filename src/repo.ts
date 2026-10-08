import { execFileSync } from "node:child_process";
import { statSync } from "node:fs";
import { dirname } from "node:path";

export type GitRunner = (args: string[], cwd: string) => string | null;

export interface RepoInfo {
  root: string;
  identity: string | null;
}

export interface RepoResolver {
  resolveDirectory(directory: string): RepoInfo | null;
  resolvePath(path: string): RepoInfo | null;
}

export interface RepoResolverOptions {
  git?: GitRunner;
  isDirectory?: (path: string) => boolean;
}

export const execGit: GitRunner = (args, cwd) => {
  try {
    const output = execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5000,
    });
    const trimmed = output.trim();
    return trimmed === "" ? null : trimmed;
  } catch {
    return null;
  }
};

function existingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function splitRemote(url: string): { host: string; path: string } | null {
  const trimmed = url.trim();
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(.+)$/i.exec(trimmed);
  if (withScheme) {
    const scheme = withScheme[1]!.toLowerCase();
    if (scheme === "file") return null;
    const rest = withScheme[2]!;
    const slash = rest.indexOf("/");
    if (slash < 0) return null;
    const authority = rest.slice(0, slash);
    const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
    const host = hostPort.replace(/:\d*$/, "");
    return { host, path: rest.slice(slash + 1) };
  }
  const scpLike = /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/)(.+)$/.exec(trimmed);
  if (scpLike) return { host: scpLike[1]!, path: scpLike[2]! };
  return null;
}

export function normalizeRemoteUrl(url: string): string | null {
  const parts = splitRemote(url);
  if (!parts || parts.host === "") return null;
  const segments = parts.path
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "")
    .split("/")
    .filter((segment) => segment !== "");
  if (segments.length < 2) return null;
  if (segments.some((segment) => segment === "." || segment === "..")) return null;
  return segments.join("/").toLowerCase();
}

export function repoName(identity: string): string {
  const slash = identity.lastIndexOf("/");
  return slash < 0 ? identity : identity.slice(slash + 1);
}

export function repoOwner(identity: string): string {
  const slash = identity.lastIndexOf("/");
  return slash < 0 ? "" : identity.slice(0, slash);
}

function readRemoteUrl(git: GitRunner, root: string): string | null {
  const origin = git(["remote", "get-url", "origin"], root);
  if (origin) return origin;
  const remotes = git(["remote"], root);
  const first = remotes?.split("\n").map((line) => line.trim()).find((line) => line !== "");
  if (!first) return null;
  return git(["remote", "get-url", first], root);
}

export function createRepoResolver(options: RepoResolverOptions = {}): RepoResolver {
  const git = options.git ?? execGit;
  const isDirectory = options.isDirectory ?? existingDirectory;
  const rootByDirectory = new Map<string, string | null>();
  const identityByRoot = new Map<string, string | null>();

  function identityFor(root: string): string | null {
    if (identityByRoot.has(root)) return identityByRoot.get(root)!;
    const remote = readRemoteUrl(git, root);
    const identity = remote ? normalizeRemoteUrl(remote) : null;
    identityByRoot.set(root, identity);
    return identity;
  }

  function resolveDirectory(directory: string): RepoInfo | null {
    let root: string | null;
    if (rootByDirectory.has(directory)) {
      root = rootByDirectory.get(directory)!;
    } else {
      root = git(["rev-parse", "--show-toplevel"], directory);
      rootByDirectory.set(directory, root);
    }
    if (!root) return null;
    return { root, identity: identityFor(root) };
  }

  function resolvePath(path: string): RepoInfo | null {
    let directory = path;
    while (!isDirectory(directory)) {
      const parent = dirname(directory);
      if (parent === directory) return null;
      directory = parent;
    }
    return resolveDirectory(directory);
  }

  return { resolveDirectory, resolvePath };
}
