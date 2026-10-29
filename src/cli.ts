import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { formatStats, parseStatsArgs } from "./commands.ts";
import { resolveAgentDir, resolveConfig, type MemoryConfig } from "./config.ts";
import { loadProposalState, markApplying, needsAttention, snooze, updateNote, updateProposalState, type ProposalState } from "./proposal-state.ts";
import { discardProposal, readProposals, type Proposal } from "./proposals.ts";
import { loadPrunedState, reviewQueue } from "./review.ts";
import { proposalMarkdown, relevantHeading, skillBody, skillSection } from "./review-card.ts";
import { readSkillIndex, skillIndexRoots } from "./skill-index.ts";
import { enqueueWriter, findOnPath, shellQuote, type Which } from "./writer/enqueue.ts";
import type { QueuedJob } from "./writer/job.ts";
import { PACKAGE_ROOT } from "./writer/prompts.ts";

export const CONFIG_ENV = "PI_SKILL_MEMORY_CONFIG";
export const DISCARD_LOCK_TIMEOUT_MS = 2 * 60_000;
export const CLI_SESSION = "pi-memory-review";

export interface CliDeps {
  config: MemoryConfig;
  now: () => Date;
  home: string;
  cwd: string;
  packageRoot: string;
  which: Which;
  enqueue: (job: QueuedJob) => { runner: string; jobFile: string };
  editComment: (initial: string, skill: string) => string | null;
  runFzf: (args: string[], input: string) => string;
  terminalRows: () => number;
}

export interface CliResult {
  stdout: string;
  code: number;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadCliConfig(env: Record<string, string | undefined> = process.env, home = homedir()): MemoryConfig {
  const passed = env[CONFIG_ENV];
  if (passed) return JSON.parse(passed) as MemoryConfig;
  const agentDir = resolveAgentDir({ env, home });
  let settings: unknown = {};
  try {
    settings = JSON.parse(readFileSync(join(agentDir, "settings.json"), "utf8"));
  } catch {
    settings = {};
  }
  return resolveConfig(settings, { env, home });
}

function displayPath(path: string, home: string): string {
  const fromHome = relative(home, path);
  return fromHome.startsWith("..") ? path : `~/${fromHome}`;
}

function oneLine(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

function tags(proposal: Proposal, state: ProposalState, now: Date): string {
  const note = state.proposals[proposal.id];
  const marks: string[] = [];
  if (note?.snoozedUntil && Date.parse(note.snoozedUntil) > now.getTime()) marks.push("omitted");
  if (note?.comment) marks.push("✎");
  if (needsAttention(note, now)) marks.push("⚠ apply failed");
  else if (note?.lastError) marks.push("⚠");
  return marks.length === 0 ? "" : ` [${marks.join(" ")}]`;
}

export function listLines(config: MemoryConfig, now: Date): string[] {
  const proposals = readProposals(config.dir);
  const state = loadPrunedState(config, proposals);
  return reviewQueue(proposals, state, now).map(
    (proposal) => `${proposal.id}\t${proposal.skill.padEnd(18)} ${oneLine(proposal.rule, 90)}${tags(proposal, state, now)}`,
  );
}

function findProposal(config: MemoryConfig, id: string | undefined): Proposal {
  const proposal = readProposals(config.dir).find((candidate) => candidate.id === id);
  if (!proposal) throw new Error(`no proposal with id ${id ?? "(missing)"}`);
  return proposal;
}

export function showMarkdown(proposal: Proposal, state: ProposalState, deps: Pick<CliDeps, "config" | "home" | "cwd">): string {
  const note = state.proposals[proposal.id];
  const head = [
    `# proposal:${proposal.skill} · ${proposal.date}`,
    proposalMarkdown({
      proposal,
      comment: note?.comment ?? "",
      lastError: note?.lastError ?? "",
      position: 0,
      total: 0,
      skillPath: null,
      skillText: null,
    }),
  ];
  const entry = readSkillIndex(skillIndexRoots({ agentDir: deps.config.agentDir, home: deps.home, cwd: deps.cwd }), deps.config.dir).find(
    (candidate) => candidate.name === proposal.skill,
  );
  let text: string | null = null;
  try {
    text = entry ? readFileSync(entry.path, "utf8") : null;
  } catch {
    text = null;
  }
  if (!entry || text === null) return [...head, `*No SKILL.md found for ${proposal.skill} in the skill index.*`].join("\n\n");
  const section = skillSection(text, relevantHeading(skillBody(text), `${proposal.rule} ${proposal.why}`));
  return [...head, "---", `Closest section by shared words, in ${displayPath(entry.path, deps.home)}:${section.line}`, section.text].join("\n\n") + "\n";
}

export function selfCommand(packageRoot: string): string {
  return [process.execPath, join(packageRoot, "src", "cli.ts")].map(shellQuote).join(" ");
}

export function previewCommand(which: Which): string {
  return which("bat") ? 'bat --language=md --color=always --style=plain --paging=never --theme="${BAT_THEME:-ansi}"' : "cat";
}

export type ReviewChoice = "apply" | "comment" | "discard" | "omit" | "skip" | "quit";

export const REVIEW_ACTIONS: { key: string; choice: ReviewChoice; label: string }[] = [
  { key: "a", choice: "apply", label: "Apply — queue it for the background apply job" },
  { key: "c", choice: "comment", label: "Comment — add an instruction for the apply job" },
  { key: "d", choice: "discard", label: "Discard — delete it from proposals.md" },
  { key: "o", choice: "omit", label: "Omit — hide it for 24 hours" },
  { key: "s", choice: "skip", label: "Skip — leave it for now and show the next one" },
  { key: "q", choice: "quit", label: "Quit" },
];

export const REVIEW_KEYS = "a/c/d/o/s/q or Enter · j/k, ctrl-d/u or wheel scroll the proposal";

export function actionLines(): string {
  return REVIEW_ACTIONS.map((action) => `${action.key}\t${action.key}  ${action.label}\n`).join("");
}

export const CARD_CHROME_ROWS = 3;
export const MIN_PREVIEW_ROWS = 5;

export function previewRows(terminalRows: number): number {
  return Math.max(MIN_PREVIEW_ROWS, terminalRows - CARD_CHROME_ROWS - 2 - REVIEW_ACTIONS.length);
}

export function cardArgs(input: { packageRoot: string; preview: string; id: string; position: number; total: number; skill: string; message: string; rows: number }): string[] {
  const show = `${selfCommand(input.packageRoot)} show ${shellQuote(input.id)} | ${input.preview}`;
  const header = `${REVIEW_KEYS}\n${input.message === "" ? " " : input.message}`;
  return [
    "--with-shell=/bin/sh -c",
    "--ansi",
    "--no-input",
    "--no-sort",
    "--layout=reverse",
    "--delimiter=\t",
    "--with-nth=2..",
    "--border=rounded",
    `--border-label= memory proposal ${input.position} of ${input.total} · ${input.skill} `,
    "--info=hidden",
    `--preview-window=up,${previewRows(input.rows)},wrap,border-bottom`,
    "--color=16",
    `--preview=${show}`,
    `--header=${header}`,
    `--bind=${REVIEW_ACTIONS.map((action) => `${action.key}:print(${action.key})+accept`).join(",")}`,
    "--bind=esc:print(q)+accept",
    "--bind=j:preview-down+preview-down+preview-down,k:preview-up+preview-up+preview-up",
    "--bind=ctrl-d:preview-half-page-down,ctrl-u:preview-half-page-up,space:preview-page-down",
  ];
}

export function parseChoice(output: string): ReviewChoice {
  const key = output.split("\n")[0]?.split("\t")[0]?.trim() ?? "";
  return REVIEW_ACTIONS.find((action) => action.key === key)?.choice ?? "quit";
}

async function act(choice: Exclude<ReviewChoice, "skip" | "quit">, proposal: Proposal, deps: CliDeps): Promise<string> {
  const { config } = deps;
  if (choice === "apply") {
    const note = loadProposalState(config.stateDir).proposals[proposal.id];
    updateProposalState(config.stateDir, (state) => markApplying(state, proposal.id, deps.now(), "user"));
    try {
      deps.enqueue({
        kind: "apply",
        config,
        sessionId: CLI_SESSION,
        cwd: deps.cwd,
        packageRoot: deps.packageRoot,
        createdAt: deps.now().toISOString(),
        proposals: [{ id: proposal.id, skill: proposal.skill, rule: proposal.rule, why: proposal.why, evidence: proposal.evidence, comment: note?.comment ?? "" }],
      });
    } catch (error) {
      updateProposalState(config.stateDir, (state) => updateNote(state, proposal.id, { applyingSince: undefined }));
      throw error;
    }
    return `Queued ${proposal.skill}: the background job commits it locally and never pushes.`;
  }
  if (choice === "comment") {
    const current = loadProposalState(config.stateDir).proposals[proposal.id]?.comment ?? "";
    const edited = deps.editComment(current, proposal.skill);
    if (edited === null) return `Kept the comment on ${proposal.skill} as it was.`;
    updateProposalState(config.stateDir, (state) => updateNote(state, proposal.id, { comment: edited.trim() || undefined }));
    return edited.trim() === "" ? `Cleared the comment on ${proposal.skill}.` : `Saved the comment on ${proposal.skill}.`;
  }
  if (choice === "discard") {
    await discardProposal(config.dir, proposal, { autoCommit: config.autoCommit, lock: { timeoutMs: DISCARD_LOCK_TIMEOUT_MS } });
    updateProposalState(config.stateDir, (state) => {
      delete state.proposals[proposal.id];
    });
    return `Discarded the ${proposal.skill} proposal.`;
  }
  updateProposalState(config.stateDir, (state) => snooze(state, proposal.id, deps.now()));
  return `Omitted the ${proposal.skill} proposal for 24 hours.`;
}

export async function review(deps: CliDeps): Promise<string> {
  const { config } = deps;
  const proposals = readProposals(config.dir);
  const queue = reviewQueue(proposals, loadPrunedState(config, proposals), deps.now()).map((proposal) => proposal.id);
  if (queue.length === 0) return "No memory proposals to review.";
  const preview = previewCommand(deps.which);
  const counts = { apply: 0, comment: 0, discard: 0, omit: 0, skip: 0 };
  let message = "";
  for (let index = 0; index < queue.length; index++) {
    const proposal = readProposals(config.dir).find((candidate) => candidate.id === queue[index]);
    if (!proposal) continue;
    const output = deps.runFzf(
      cardArgs({ packageRoot: deps.packageRoot, preview, id: proposal.id, position: index + 1, total: queue.length, skill: proposal.skill, message, rows: deps.terminalRows() }),
      actionLines(),
    );
    const choice = parseChoice(output);
    if (choice === "quit") break;
    counts[choice]++;
    if (choice === "skip") {
      message = `Skipped the ${proposal.skill} proposal.`;
      continue;
    }
    try {
      message = await act(choice, proposal, deps);
    } catch (error) {
      message = `Failed to ${choice} the ${proposal.skill} proposal: ${errorMessage(error)}`;
    }
    if (choice === "comment") index--;
  }
  const done = [
    counts.apply > 0 ? `queued ${counts.apply}` : "",
    counts.discard > 0 ? `discarded ${counts.discard}` : "",
    counts.omit > 0 ? `omitted ${counts.omit}` : "",
    counts.skip > 0 ? `skipped ${counts.skip}` : "",
  ].filter((part) => part !== "");
  return done.length === 0 ? "No proposals changed." : `Reviewed proposals: ${done.join(", ")}.`;
}

export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const [command, id] = argv;
  const { config } = deps;
  try {
    if (command === "stats") return { stdout: `${formatStats(config, parseStatsArgs(argv.slice(1)))}\n`, code: 0 };
    if (command === "list") return { stdout: listLines(config, deps.now()).map((line) => `${line}\n`).join(""), code: 0 };
    if (command === "show") {
      const proposal = findProposal(config, id);
      return { stdout: showMarkdown(proposal, loadProposalState(config.stateDir), deps), code: 0 };
    }
    if (command === "apply" || command === "comment" || command === "discard" || command === "omit") {
      return { stdout: `${await act(command, findProposal(config, id), deps)}\n`, code: 0 };
    }
    if (command === "review" || command === undefined) {
      if (!deps.which("fzf")) return { stdout: "pi-memory review needs fzf on PATH (brew install fzf).\n", code: 1 };
      return { stdout: `${await review(deps)}\n`, code: 0 };
    }
    return { stdout: "usage: pi-memory [review|list|show|apply|comment|discard|omit|stats] [id or --since YYYY-MM-DD]\n", code: 2 };
  } catch (error) {
    return { stdout: `${errorMessage(error)}\n`, code: 1 };
  }
}

function editInEditor(initial: string, skill: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-comment-"));
  const file = join(dir, `${skill}-comment.md`);
  writeFileSync(file, initial);
  try {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const result = spawnSync("/bin/sh", ["-c", `${editor} ${shellQuote(file)}`], { stdio: "inherit" });
    if (result.status !== 0) return null;
    return readFileSync(file, "utf8");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function defaultCliDeps(env: Record<string, string | undefined> = process.env): CliDeps {
  const config = loadCliConfig(env);
  const childEnv = { ...process.env, [CONFIG_ENV]: JSON.stringify(config) };
  return {
    config,
    now: () => new Date(),
    home: homedir(),
    cwd: process.cwd(),
    packageRoot: PACKAGE_ROOT,
    which: findOnPath,
    enqueue: (job) => enqueueWriter(job, { which: findOnPath }),
    editComment: editInEditor,
    terminalRows: () => process.stdout.rows || process.stderr.rows || 40,
    runFzf: (args, input) => spawnSync("fzf", args, { input, stdio: ["pipe", "pipe", "inherit"], env: childEnv, encoding: "utf8" }).stdout ?? "",
  };
}

function isEntryPoint(): boolean {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(resolve(entry)) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntryPoint()) {
  runCli(process.argv.slice(2), defaultCliDeps()).then(
    (result) => {
      process.stdout.write(result.stdout);
      process.exitCode = result.code;
    },
    (error) => {
      console.error(errorMessage(error));
      process.exitCode = 1;
    },
  );
}
