import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveAgentDir, resolveConfig, type MemoryConfig } from "./config.ts";
import { loadProposalState, snooze, updateNote, updateProposalState, type ProposalState } from "./proposal-state.ts";
import { discardProposal, readProposals, type Proposal } from "./proposals.ts";
import { loadPrunedState, reviewQueue } from "./review.ts";
import { proposalMarkdown, relevantHeading, skillBody, skillSection } from "./review-card.ts";
import { readSkillIndex, skillIndexRoots } from "./skill-index.ts";
import { enqueueWriter, findOnPath, shellQuote, type Which } from "./writer/enqueue.ts";
import type { QueuedJob } from "./writer/job.ts";
import { PACKAGE_ROOT } from "./writer/prompts.ts";

export const CONFIG_ENV = "PI_SKILL_MEMORY_CONFIG";
export const MESSAGE_FILE = "review-message.txt";
export const DISCARD_LOCK_TIMEOUT_MS = 2 * 60_000;
export const CLI_SESSION = "pi-memory-review";
export const REVIEW_KEYS = "a apply · c comment · d discard · o omit · j/k move · ctrl-d/u or wheel scroll preview · q quit";

export interface CliDeps {
  config: MemoryConfig;
  now: () => Date;
  home: string;
  cwd: string;
  packageRoot: string;
  which: Which;
  enqueue: (job: QueuedJob) => { runner: string; jobFile: string };
  editComment: (initial: string, skill: string) => string | null;
  runFzf: (args: string[], listCommand: string) => number;
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
  if (note?.lastError) marks.push("⚠");
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

function setMessage(config: MemoryConfig, message: string): void {
  try {
    writeFileSync(join(config.stateDir, MESSAGE_FILE), message);
  } catch {
    return;
  }
}

export function headerText(config: MemoryConfig): string {
  let message = "";
  try {
    message = readFileSync(join(config.stateDir, MESSAGE_FILE), "utf8").trim();
  } catch {
    message = "";
  }
  return message === "" ? REVIEW_KEYS : `${REVIEW_KEYS}\n${message}`;
}

export function selfCommand(packageRoot: string): string {
  return [process.execPath, join(packageRoot, "src", "cli.ts")].map(shellQuote).join(" ");
}

export function fzfArgs(packageRoot: string, preview: string): string[] {
  const self = selfCommand(packageRoot);
  const act = (key: string, verb: string, silent = true) =>
    `${key}:${silent ? "execute-silent" : "execute"}(${self} ${verb} {1})+reload(${self} list)+transform-header(${self} header)+refresh-preview`;
  return [
    "--ansi",
    "--no-input",
    "--no-sort",
    "--layout=reverse",
    "--delimiter=\t",
    "--with-nth=2..",
    "--border=rounded",
    "--border-label= memory proposals ",
    "--preview-window=up,65%,wrap,border-bottom",
    `--preview=${self} show {1} | ${preview}`,
    `--header=${REVIEW_KEYS}`,
    `--bind=${act("a", "apply")}`,
    `--bind=${act("c", "comment", false)}`,
    `--bind=${act("d", "discard")}`,
    `--bind=${act("o", "omit")}`,
    "--bind=j:down,k:up,q:abort,esc:abort",
    "--bind=ctrl-d:preview-half-page-down,ctrl-u:preview-half-page-up,space:preview-page-down",
    "--bind=zero:transform-header(echo 'No proposals left · q quits')",
  ];
}

export function previewCommand(which: Which): string {
  return which("bat") ? "bat --language=md --color=always --style=plain --paging=never" : "cat";
}

export async function runCli(argv: string[], deps: CliDeps): Promise<CliResult> {
  const [command, id] = argv;
  const { config } = deps;
  try {
    if (command === "list") return { stdout: listLines(config, deps.now()).map((line) => `${line}\n`).join(""), code: 0 };
    if (command === "header") return { stdout: `${headerText(config)}\n`, code: 0 };
    if (command === "show") {
      const proposal = findProposal(config, id);
      return { stdout: showMarkdown(proposal, loadProposalState(config.stateDir), deps), code: 0 };
    }
    if (command === "apply") {
      const proposal = findProposal(config, id);
      const note = loadProposalState(config.stateDir).proposals[proposal.id];
      updateProposalState(config.stateDir, (state) => updateNote(state, proposal.id, { applyingSince: deps.now().toISOString(), snoozedUntil: undefined, lastError: undefined }));
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
      setMessage(config, `Queued ${proposal.skill}: the background job commits it locally and never pushes.`);
      return { stdout: "", code: 0 };
    }
    if (command === "comment") {
      const proposal = findProposal(config, id);
      const current = loadProposalState(config.stateDir).proposals[proposal.id]?.comment ?? "";
      const edited = deps.editComment(current, proposal.skill);
      if (edited === null) return { stdout: "", code: 0 };
      updateProposalState(config.stateDir, (state) => updateNote(state, proposal.id, { comment: edited.trim() || undefined }));
      setMessage(config, edited.trim() === "" ? `Cleared the comment on ${proposal.skill}.` : `Saved the comment on ${proposal.skill}.`);
      return { stdout: "", code: 0 };
    }
    if (command === "discard") {
      const proposal = findProposal(config, id);
      await discardProposal(config.dir, proposal, { autoCommit: config.autoCommit, lock: { timeoutMs: DISCARD_LOCK_TIMEOUT_MS } });
      updateProposalState(config.stateDir, (state) => {
        delete state.proposals[proposal.id];
      });
      setMessage(config, `Discarded the ${proposal.skill} proposal.`);
      return { stdout: "", code: 0 };
    }
    if (command === "omit") {
      const proposal = findProposal(config, id);
      updateProposalState(config.stateDir, (state) => snooze(state, proposal.id, deps.now()));
      setMessage(config, `Omitted the ${proposal.skill} proposal for 24 hours.`);
      return { stdout: "", code: 0 };
    }
    if (command === "review" || command === undefined) {
      if (!deps.which("fzf")) return { stdout: "pi-memory review needs fzf on PATH (brew install fzf).\n", code: 1 };
      setMessage(config, "");
      const code = deps.runFzf(fzfArgs(deps.packageRoot, previewCommand(deps.which)), `${selfCommand(deps.packageRoot)} list`);
      setMessage(config, "");
      return { stdout: "", code: code === 130 || code === 1 ? 0 : code };
    }
    return { stdout: "usage: pi-memory [review|list|show|apply|comment|discard|omit|header] [id]\n", code: 2 };
  } catch (error) {
    setMessage(config, `Failed: ${errorMessage(error)}`);
    return { stdout: `${errorMessage(error)}\n`, code: 1 };
  }
}

function editInEditor(initial: string, skill: string): string | null {
  const dir = mkdtempSync(join(tmpdir(), "pi-memory-comment-"));
  const file = join(dir, `${skill}-comment.md`);
  writeFileSync(file, initial);
  try {
    const editor = process.env.VISUAL || process.env.EDITOR || "vi";
    const result = spawnSync(process.env.SHELL || "/bin/sh", ["-c", `${editor} ${shellQuote(file)}`], { stdio: "inherit" });
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
    runFzf: (args, listCommand) => spawnSync("fzf", args, { stdio: "inherit", env: { ...childEnv, FZF_DEFAULT_COMMAND: listCommand } }).status ?? 1,
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
