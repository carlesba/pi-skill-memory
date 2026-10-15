import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fzfArgs, headerText, listLines, previewCommand, REVIEW_KEYS, runCli, type CliDeps } from "../src/cli.ts";
import { resolveConfig } from "../src/config.ts";
import { loadProposalState } from "../src/proposal-state.ts";
import { readProposals } from "../src/proposals.ts";
import type { QueuedJob } from "../src/writer/job.ts";

const PROPOSALS = `## 2026-10-09 proposal:react-code

- Rule: Do not wrap a provider value in useMemo when its inputs change on every render.
- Why: The memo never hits.
- Evidence: "if not we should avoid it."
- Session: s1

## 2026-10-09 proposal:git

- Rule: Rebase before pushing.
- Why: Linear history.
- Evidence: "rebase first"
- Session: s2
`;

function fixture(options: { fzf?: boolean; bat?: boolean; comment?: string | null } = {}) {
  const root = mkdtempSync(join(tmpdir(), "psm-cli-"));
  const agentDir = join(root, ".pi", "agent");
  const config = { ...resolveConfig({ memory: { dir: join(root, "memory"), stateDir: join(root, "state"), autoCommit: false } }, { env: { PI_CODING_AGENT_DIR: agentDir }, home: root }) };
  mkdirSync(config.dir, { recursive: true });
  mkdirSync(config.stateDir, { recursive: true });
  writeFileSync(join(config.dir, "proposals.md"), PROPOSALS);
  const skillDir = join(agentDir, "skills", "react-code");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: react-code\ndescription: React\n---\n\n# React code\n\n## Styling\n\nStyle.\n\n## Providers and memo\n\nProviders and useMemo on a provider value.\n");
  const jobs: QueuedJob[] = [];
  const fzfRuns: { args: string[]; list: string }[] = [];
  const deps: CliDeps = {
    config,
    now: () => new Date("2025-03-01T12:00:00.000Z"),
    home: root,
    cwd: root,
    packageRoot: "/pkg",
    which: (command) => ((command === "fzf" && options.fzf !== false) || (command === "bat" && options.bat) ? `/bin/${command}` : null),
    enqueue: (job) => {
      jobs.push(job);
      return { runner: "detached", jobFile: "job.json" };
    },
    editComment: () => (options.comment === undefined ? "put it under Providers\n" : options.comment),
    runFzf: (args, list) => {
      fzfRuns.push({ args, list });
      return 130;
    },
  };
  const ids = readProposals(config.dir).map((proposal) => proposal.id);
  return { deps, config, jobs, fzfRuns, ids };
}

test("list prints one tab-separated row per pending proposal with its id first", async () => {
  const { deps, ids } = fixture();
  const { stdout, code } = await runCli(["list"], deps);
  assert.equal(code, 0);
  const rows = stdout.trimEnd().split("\n");
  assert.equal(rows.length, 2);
  assert.equal(rows[0]!.split("\t")[0], ids[0]);
  assert.match(rows[0]!, /\treact-code\s+Do not wrap a provider value/);
});

test("show prints the proposal and the closest skill section with its path and line", async () => {
  const { deps, ids } = fixture();
  const { stdout } = await runCli(["show", ids[0]!], deps);
  assert.match(stdout, /^# proposal:react-code · 2026-10-09/);
  assert.match(stdout, /\*\*Rule\*\* Do not wrap/);
  assert.match(stdout, /in ~\/\.pi\/agent\/skills\/react-code\/SKILL\.md:12\n\n## Providers and memo/);
  assert.doesNotMatch(stdout, /Style\./);
  assert.match((await runCli(["show", ids[1]!], deps)).stdout, /No SKILL\.md found for git/);
});

test("comment saves the edited note, tags the row, and apply queues it with the comment", async () => {
  const { deps, config, jobs, ids } = fixture();
  await runCli(["comment", ids[0]!], deps);
  assert.equal(loadProposalState(config.stateDir).proposals[ids[0]!]!.comment, "put it under Providers");
  assert.match(listLines(config, deps.now())[0]!, /\[✎\]$/);
  assert.match((await runCli(["show", ids[0]!], deps)).stdout, /\*\*Comment\*\* put it under Providers/);
  assert.match(headerText(config), /Saved the comment on react-code\./);

  await runCli(["apply", ids[0]!], deps);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.kind, "apply");
  assert.deepEqual((jobs[0] as { proposals: unknown[] }).proposals, [
    { id: ids[0], skill: "react-code", rule: "Do not wrap a provider value in useMemo when its inputs change on every render.", why: "The memo never hits.", evidence: "if not we should avoid it.", comment: "put it under Providers" },
  ]);
  assert.equal(loadProposalState(config.stateDir).proposals[ids[0]!]!.applyingSince, "2025-03-01T12:00:00.000Z");
  assert.equal(listLines(config, deps.now()).length, 1);
  assert.match(headerText(config), /Queued react-code/);
});

test("a cancelled editor keeps the old comment", async () => {
  const { deps, config, ids } = fixture({ comment: null });
  await runCli(["comment", ids[0]!], deps);
  assert.equal(loadProposalState(config.stateDir).proposals[ids[0]!], undefined);
});

test("discard removes the entry and omit snoozes it, and both leave a header message", async () => {
  const { deps, config, ids } = fixture();
  await runCli(["discard", ids[1]!], deps);
  assert.deepEqual(readProposals(config.dir).map((proposal) => proposal.id), [ids[0]]);
  assert.match(headerText(config), /Discarded the git proposal\./);
  await runCli(["omit", ids[0]!], deps);
  assert.equal(loadProposalState(config.stateDir).proposals[ids[0]!]!.snoozedUntil, "2025-03-02T12:00:00.000Z");
  assert.match(listLines(config, deps.now())[0]!, /\[omitted\]$/);
});

test("an unknown id fails with a message and a non-zero code", async () => {
  const { deps, config } = fixture();
  const result = await runCli(["apply", "nope"], deps);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /no proposal with id nope/);
  assert.match(headerText(config), /Failed: no proposal with id nope/);
});

test("review runs fzf with key bindings, a bat preview and the list as its source, and needs fzf", async () => {
  const { deps, fzfRuns } = fixture({ bat: true });
  assert.equal((await runCli(["review"], deps)).code, 0);
  const [run] = fzfRuns;
  assert.match(run!.list, /src\/cli\.ts list$/);
  const args = run!.args.join("\n");
  assert.match(args, /--preview=.*src\/cli\.ts show \{1\} \| bat --language=md/);
  for (const [key, verb] of [["a", "apply"], ["d", "discard"], ["o", "omit"]]) {
    assert.match(args, new RegExp(`--bind=${key}:execute-silent\\(.* ${verb} \\{1\\}\\)\\+reload\\(.* list\\)`));
  }
  assert.match(args, /--bind=c:execute\(.* comment \{1\}\)/);
  assert.match(args, /--no-input/);
  assert.match(args, /--theme="\$\{BAT_THEME:-ansi\}"/);
  assert.match(args, /--color=16/);
  assert.ok(run!.args.includes(`--header=${REVIEW_KEYS}`));
  assert.equal(previewCommand(() => null), "cat");

  const missing = fixture({ fzf: false });
  const result = await runCli(["review"], missing.deps);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /needs fzf/);
  assert.equal(missing.fzfRuns.length, 0);
  assert.ok(fzfArgs("/pkg", "cat").some((arg) => arg.startsWith("--preview-window=up")));
});
