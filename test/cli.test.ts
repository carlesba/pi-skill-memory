import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { actionLines, cardArgs, listLines, parseChoice, previewCommand, previewRows, REVIEW_KEYS, runCli, type CliDeps } from "../src/cli.ts";
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

function fixture(options: { fzf?: boolean; bat?: boolean; comment?: string | null; keys?: string[] } = {}) {
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
  const fzfRuns: { args: string[]; input: string }[] = [];
  const keys = [...(options.keys ?? [])];
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
    terminalRows: () => 30,
    runFzf: (args, input) => {
      fzfRuns.push({ args, input });
      return `${keys.shift() ?? "q"}\n`;
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

  await runCli(["apply", ids[0]!], deps);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0]!.kind, "apply");
  assert.deepEqual((jobs[0] as { proposals: unknown[] }).proposals, [
    { id: ids[0], skill: "react-code", rule: "Do not wrap a provider value in useMemo when its inputs change on every render.", why: "The memo never hits.", evidence: "if not we should avoid it.", comment: "put it under Providers" },
  ]);
  assert.equal(loadProposalState(config.stateDir).proposals[ids[0]!]!.applyingSince, "2025-03-01T12:00:00.000Z");
  assert.equal(listLines(config, deps.now()).length, 1);
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
  await runCli(["omit", ids[0]!], deps);
  assert.equal(loadProposalState(config.stateDir).proposals[ids[0]!]!.snoozedUntil, "2025-03-02T12:00:00.000Z");
  assert.match(listLines(config, deps.now())[0]!, /\[omitted\]$/);
});

test("an unknown id fails with a message and a non-zero code", async () => {
  const { deps } = fixture();
  const result = await runCli(["apply", "nope"], deps);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /no proposal with id nope/);
});

test("review shows one proposal at a time and moves on after each decision", async () => {
  const { deps, config, jobs, fzfRuns, ids } = fixture({ bat: true, keys: ["c", "a", "s"] });
  const result = await runCli(["review"], deps);
  assert.equal(result.code, 0);
  assert.equal(result.stdout, "Reviewed proposals: queued 1, skipped 1.\n");
  assert.equal(fzfRuns.length, 3);
  const [first, again, second] = fzfRuns.map((run) => run.args.join("\n"));
  assert.match(first!, /--border-label= memory proposal 1 of 2 · react-code /);
  assert.match(first!, new RegExp(`--preview=.*src/cli\\.ts show ${ids[0]} \\| bat --language=md`));
  assert.match(again!, /memory proposal 1 of 2 · react-code[\s\S]*Saved the comment on react-code\./);
  assert.match(second!, /memory proposal 2 of 2 · git[\s\S]*Queued react-code/);
  assert.equal((jobs[0] as { proposals: { comment: string }[] }).proposals[0]!.comment, "put it under Providers");
  assert.equal(readProposals(config.dir).length, 2);
  assert.equal(fzfRuns[0]!.input, actionLines());
});

test("quitting stops the review, omitted proposals are not shown again in the same run, and an empty queue says so", async () => {
  const quit = fixture({ keys: ["q"] });
  assert.equal((await runCli(["review"], quit.deps)).stdout, "No proposals changed.\n");
  assert.equal(quit.fzfRuns.length, 1);

  const omit = fixture({ keys: ["o", "o"] });
  assert.equal((await runCli(["review"], omit.deps)).stdout, "Reviewed proposals: omitted 2.\n");
  assert.equal(omit.fzfRuns.length, 2);
  const after = fixture({ keys: ["d", "d"] });
  await runCli(["review"], after.deps);
  assert.equal((await runCli(["review"], after.deps)).stdout, "No memory proposals to review.\n");
});

test("the card binds a single key per action, scrolls the preview with j/k, and runs under /bin/sh", () => {
  const args = cardArgs({ packageRoot: "/pkg", preview: "cat", id: "abc", position: 2, total: 5, skill: "git", message: "", rows: 30 });
  const joined = args.join("\n");
  assert.equal(args[0], "--with-shell=/bin/sh -c");
  assert.match(joined, /--bind=a:print\(a\)\+accept,c:print\(c\)\+accept,d:print\(d\)\+accept,o:print\(o\)\+accept,s:print\(s\)\+accept,q:print\(q\)\+accept/);
  assert.match(joined, /--bind=j:preview-down\+preview-down\+preview-down,k:preview-up\+preview-up\+preview-up/);
  assert.match(joined, /--preview-window=up,19,/);
  assert.ok(args.includes(`--header=${REVIEW_KEYS}\n `));
  assert.equal(previewRows(30), 19);
  assert.equal(previewRows(8), 5);
  assert.equal(parseChoice("d\n"), "discard");
  assert.equal(parseChoice("c\tc  Comment\n"), "comment");
  assert.equal(parseChoice(""), "quit");
  assert.match(actionLines(), /^a\ta  Apply/);
  assert.match(previewCommand(() => "/bin/bat"), /--theme="\$\{BAT_THEME:-ansi\}"/);
  assert.equal(previewCommand(() => null), "cat");
});

test("review needs fzf", async () => {
  const missing = fixture({ fzf: false });
  const result = await runCli(["review"], missing.deps);
  assert.equal(result.code, 1);
  assert.match(result.stdout, /needs fzf/);
  assert.equal(missing.fzfRuns.length, 0);
});

test("stats runs without review dependencies and reports invalid date arguments", async () => {
  const { deps, jobs, fzfRuns } = fixture({ fzf: false });
  const result = await runCli(["stats", "--since", "2026-10-29"], deps);
  assert.equal(result.code, 0);
  assert.match(result.stdout, /Memory stats \(since 2026-10-29, UTC inclusive\)/);
  assert.deepEqual(jobs, []);
  assert.deepEqual(fzfRuns, []);
  const invalid = await runCli(["stats", "--since", "2026-02-30"], deps);
  assert.equal(invalid.code, 1);
  assert.match(invalid.stdout, /usage: stats/);
});

test("redescribe CLI is noninteractive and reports argument errors", async () => {
  const { deps, fzfRuns, jobs } = fixture({ fzf: false });
  const preview = await runCli(["redescribe", "--dry-run"], deps);
  assert.equal(preview.code, 0);
  assert.match(preview.stdout, /Topic \| Before \| After/);
  assert.match(preview.stdout, /Dry run: no descriptions written/);
  const invalid = await runCli(["redescribe", "--topic"], deps);
  assert.equal(invalid.code, 1);
  assert.equal(invalid.stdout, "usage: pi-memory redescribe [--dry-run] [--topic <name>]\n");
  assert.equal((await runCli(["redescribe", "--topic", "missing"], deps)).code, 1);
  assert.deepEqual(fzfRuns, []);
  assert.deepEqual(jobs, []);
});
