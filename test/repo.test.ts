import { strict as assert } from "node:assert";
import { test } from "node:test";
import { createRepoResolver, normalizeRemoteUrl, repoName, repoOwner, type GitRunner } from "../src/repo.ts";

test("normalizes https, ssh scp-form and ssh:// remotes to owner/name", () => {
  assert.equal(normalizeRemoteUrl("https://github.com/preply/apollo"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("https://github.com/preply/apollo.git"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("git@github.com:preply/apollo.git"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("github.com:preply/apollo"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("ssh://git@github.com/preply/apollo.git"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("ssh://git@github.com:2222/preply/apollo.git"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("git+ssh://git@github.com/preply/apollo"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("git://github.com/preply/apollo.git"), "preply/apollo");
});

test("tolerates case, credentials and trailing slashes", () => {
  assert.equal(normalizeRemoteUrl("https://GitHub.COM/Preply/Apollo.GIT"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("https://user:token@github.com/preply/apollo.git"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("https://github.com/preply/apollo/"), "preply/apollo");
  assert.equal(normalizeRemoteUrl("  git@github.com:preply/apollo.git\n"), "preply/apollo");
});

test("keeps gitlab subgroups as the owner path", () => {
  const identity = normalizeRemoteUrl("git@gitlab.com:group/subgroup/project.git");
  assert.equal(identity, "group/subgroup/project");
  assert.equal(repoOwner(identity!), "group/subgroup");
  assert.equal(repoName(identity!), "project");
  assert.equal(normalizeRemoteUrl("https://gitlab.com/group/subgroup/project"), "group/subgroup/project");
});

test("rejects remotes without an owner/name path", () => {
  assert.equal(normalizeRemoteUrl("/srv/git/apollo.git"), null);
  assert.equal(normalizeRemoteUrl("file:///srv/git/apollo.git"), null);
  assert.equal(normalizeRemoteUrl("https://github.com/apollo"), null);
  assert.equal(normalizeRemoteUrl("../apollo"), null);
  assert.equal(normalizeRemoteUrl(""), null);
});

function fakeGit(repos: Record<string, { root: string; remotes: Record<string, string> }>) {
  const calls: string[] = [];
  const git: GitRunner = (args, cwd) => {
    calls.push(`${cwd}: ${args.join(" ")}`);
    const repo = repos[cwd] ?? Object.values(repos).find((candidate) => candidate.root === cwd);
    if (!repo) return null;
    if (args[0] === "rev-parse") return repo.root;
    if (args[0] === "remote" && args.length === 1) return Object.keys(repo.remotes).join("\n") || null;
    if (args[0] === "remote" && args[1] === "get-url") return repo.remotes[args[2]!] ?? null;
    return null;
  };
  return { git, calls };
}

test("resolves a directory to its git root and identity, caching per directory and root", () => {
  const { git, calls } = fakeGit({
    "/w/apollo": { root: "/w/apollo", remotes: { origin: "git@github.com:preply/apollo.git" } },
    "/w/apollo/src": { root: "/w/apollo", remotes: { origin: "git@github.com:preply/apollo.git" } },
  });
  const resolver = createRepoResolver({ git, isDirectory: () => true });
  assert.deepEqual(resolver.resolveDirectory("/w/apollo/src"), { root: "/w/apollo", identity: "preply/apollo" });
  assert.deepEqual(resolver.resolveDirectory("/w/apollo"), { root: "/w/apollo", identity: "preply/apollo" });
  resolver.resolveDirectory("/w/apollo/src");
  assert.equal(calls.filter((call) => call.includes("rev-parse")).length, 2);
  assert.equal(calls.filter((call) => call.includes("get-url")).length, 1);
});

test("falls back to the first remote when origin is missing, and returns null outside git", () => {
  const { git } = fakeGit({
    "/w/fork": { root: "/w/fork", remotes: { upstream: "https://github.com/preply/apollo.git" } },
  });
  const resolver = createRepoResolver({ git, isDirectory: () => true });
  assert.deepEqual(resolver.resolveDirectory("/w/fork"), { root: "/w/fork", identity: "preply/apollo" });
  assert.equal(resolver.resolveDirectory("/tmp"), null);
});

test("resolvePath walks up from a file to its nearest existing directory", () => {
  const { git } = fakeGit({ "/w/apollo/src": { root: "/w/apollo", remotes: { origin: "https://github.com/preply/apollo" } } });
  const resolver = createRepoResolver({ git, isDirectory: (path) => path === "/w/apollo/src" || path === "/" });
  assert.deepEqual(resolver.resolvePath("/w/apollo/src/new/file.ts"), { root: "/w/apollo", identity: "preply/apollo" });
});
