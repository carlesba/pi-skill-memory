import { parseRedescribeArgs, redescribe } from "./writer/redescribe.ts";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { CONFIG_ENV } from "./cli.ts";
import { relative } from "node:path";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  InputEvent,
  MessageStartEvent,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { formatExplain, formatStats, parseStatsArgs, formatStatus, type ListedTopic, type ReminderRecord } from "./commands.ts";
import { resolveConfig, shouldSkipWrite, type MemoryConfig } from "./config.ts";
import {
  countHumanMessages,
  INPUT_MARK_TYPE,
  messageText,
  rememberInput,
  takeInputFor,
  type InputMark,
  type PendingInput,
} from "./human.ts";
import { extractToolPaths } from "./paths.ts";
import { knownRepoIdentities, promptNamedRepos, reminderLine, reminderTopics } from "./reminders.ts";
import { failedApplies, markApplying, pendingProposals, retryableProposals, updateNote, updateProposalState } from "./proposal-state.ts";
import { discardProposal, readProposals } from "./proposals.ts";
import { createRepoResolver, type RepoResolver } from "./repo.ts";
import {
  applyNotice,
  describeReview,
  dialogReviewUI,
  formatProposalList,
  loadPrunedState,
  PROPOSALS_WIDGET,
  proposalWidgetLine,
  reviewProposals,
  type SkillSource,
} from "./review.ts";
import { readSkillIndex, skillIndexRoots } from "./skill-index.ts";
import { listTopics, topicsForRepo, type TopicSummary } from "./topics.ts";
import { runSelector, selectedTopics, selectorPrompt, topicDelivery, type SelectorRunner } from "./selector.ts";
import { appendUsageEvent } from "./usage.ts";
import { isInside } from "./writer/confine.ts";
import { enqueueWriter, findOnPath, type EnqueueResult, type Which } from "./writer/enqueue.ts";
import { processedEntryIds, recoverableSessions, unprocessedEntries, WATERMARK_TYPE } from "./writer/checkpoint.ts";
import type { ApplyProposal, QueuedJob, WriterJob, WriterTrigger } from "./writer/job.ts";
import { PACKAGE_ROOT } from "./writer/prompts.ts";
import { appendWriterLog, readLastRun } from "./writer/runs.ts";
import { memoryTopicOfPath } from "./writer/session.ts";

export const USER_MEMORY_SECTION = "user_memory";
export const USER_MEMORY_HEADING = "What this user wants from agents in every repository (pi-skill-memory user.md):";
export const REMINDER_MESSAGE_TYPE = "pi-skill-memory-reminder";
export const COMMAND_NAME = "memory";
export const DISCARD_LOCK_TIMEOUT_MS = 2 * 60_000;
export const SUBCOMMANDS = ["status", "explain", "write", "stats", "redescribe"] as const;
export const PROPOSALS_COMMAND = "proposals";

export interface ExtensionDeps {
  select: SelectorRunner;
  resolver: RepoResolver;
  enqueue: (job: QueuedJob) => EnqueueResult;
  now: () => Date;
  env: Record<string, string | undefined>;
  home: string;
  packageRoot: string;
  which: Which;
  runReviewApp: (config: MemoryConfig, ctx: ExtensionCommandContext) => Promise<number>;
}

interface SessionState {
  config: MemoryConfig;
  sessionId: string;
  userMemory: string | null;
  skillsInstruction: boolean;
  topics: TopicSummary[];
  repos: Set<string>;
  selection?: { controller: AbortController; ready: TopicSummary[]; timer: ReturnType<typeof setTimeout> };
  previousAssistant: string;
  pointed: Set<string>;
  contextMemory: string[];
  announced: Set<string>;
  pending: Map<string, string[]>;
  reminders: ReminderRecord[];
  loaded: Set<string>;
  manualWriteLeaf: string | null | undefined;
  pendingInputs: PendingInput[];
  widgetClearsOnInput: boolean;
}

type SessionView = Pick<ExtensionContext, "cwd" | "sessionManager">;
type ModeView = SessionView & Pick<ExtensionContext, "mode">;

function readUserMemory(dir: string): string | null {
  try {
    const text = readFileSync(join(dir, "user.md"), "utf8").trim();
    return text === "" ? null : text;
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export const SKILLS_INSTRUCTION = "Before acting on a request, scan the mem-* skills and read every one whose description matches the request; they hold the user's corrections.";

export function userMemorySection(snapshot: string, skillsInstruction = false): string {
  return [snapshot ? `${USER_MEMORY_HEADING}\n\n${snapshot}` : "", skillsInstruction ? SKILLS_INSTRUCTION : ""].filter(Boolean).join("\n\n");
}

export function runReviewApp(config: MemoryConfig, ctx: ExtensionCommandContext): Promise<number> {
  return ctx.ui.custom<number>((tui, _theme, _keybindings, done) => {
    tui.stop();
    process.stdout.write("\x1b[2J\x1b[H");
    const result = spawnSync(process.execPath, [join(PACKAGE_ROOT, "src", "cli.ts"), "review"], {
      stdio: "inherit",
      env: { ...process.env, [CONFIG_ENV]: JSON.stringify(config) },
    });
    tui.start();
    tui.requestRender(true);
    done(result.status ?? 1);
    return { render: () => [], invalidate: () => {} };
  });
}

export function createExtension(overrides: Partial<ExtensionDeps> = {}): (pi: ExtensionAPI) => void {
  return function piSkillMemory(pi: ExtensionAPI): void {
    const which = overrides.which ?? findOnPath;
    const deps: ExtensionDeps = {
      select: overrides.select ?? runSelector,
      resolver: overrides.resolver ?? createRepoResolver(),
      enqueue: overrides.enqueue ?? ((job) => enqueueWriter(job, { which })),
      now: overrides.now ?? (() => new Date()),
      env: overrides.env ?? process.env,
      home: overrides.home ?? homedir(),
      packageRoot: overrides.packageRoot ?? PACKAGE_ROOT,
      which,
      runReviewApp: overrides.runReviewApp ?? runReviewApp,
    };
    let state: SessionState | null = null;
    let listed: ListedTopic[] = [];

    function startSession(ctx: SessionView): SessionState {
      const config = resolveConfig(pi.getSettings(), { env: deps.env, home: deps.home });
      cancelSelection();
      const topics = listTopics(config.dir);
      state = {
        config,
        sessionId: ctx.sessionManager.getSessionId(),
        userMemory: readUserMemory(config.dir),
        topics,
        skillsInstruction: config.skillsInstruction && topics.length > 0,
        repos: new Set(),
        previousAssistant: ctx.sessionManager.getBranch().flatMap((entry) =>
          entry.type === "message" && entry.message.role === "assistant" ? [messageText(entry.message.content)] : []).at(-1)?.slice(-2000) ?? "",
        pointed: new Set(),
        contextMemory: [],
        announced: new Set(),
        pending: new Map(),
        reminders: [],
        loaded: new Set(),
        manualWriteLeaf: undefined,
        pendingInputs: [],
        widgetClearsOnInput: false,
      };
      return state;
    }

    function current(ctx: SessionView): SessionState {
      return state ?? startSession(ctx);
    }

    function logFailure(where: string, error: unknown): void {
      if (!state) return;
      try {
        appendWriterLog(state.config.stateDir, `extension ${where} failed: ${errorMessage(error)}`, deps.now());
      } catch {
        return;
      }
    }

    function recordUsage(session: SessionState, kind: "reminded" | "loaded", topic: string): void {
      appendUsageEvent(session.config.stateDir, { ts: deps.now().toISOString(), kind, topic, session: session.sessionId });
    }

    function announce(session: SessionState, identity: string, trigger: string): string | null {
      session.repos.add(identity);
      if (!session.config.reminders) return null;
      if (session.announced.has(identity)) return null;
      const names = reminderTopics(session.topics, identity);
      if (names.length === 0) return null;
      session.announced.add(identity);
      session.reminders.push({ repo: identity, topics: names, trigger });
      for (const name of names) recordUsage(session, "reminded", name);
      return reminderLine(identity, names, session.config.dir);
    }

    function cancelSelection(): void {
      if (!state?.selection) return;
      clearTimeout(state.selection.timer);
      state.selection.controller.abort();
      state.selection = undefined;
    }

    function beginSelection(session: SessionState, prompt: string, ctx: ExtensionContext): void {
      cancelSelection();
      if (!session.config.selector.enabled) return;
      const identity = deps.resolver.resolvePath(ctx.cwd)?.identity;
      if (identity) session.repos.add(identity);
      for (const match of promptNamedRepos(prompt, knownRepoIdentities(session.topics))) session.repos.add(match.identity);
      const candidates = session.topics.filter((topic) =>
        (topic.scope === "generic" || session.repos.has(topic.scope.slice(5))) &&
        !session.loaded.has(topic.name) && !session.pointed.has(topic.name));
      if (candidates.length === 0) return;
      const controller = new AbortController();
      const selection = { controller, ready: [] as TopicSummary[], timer: setTimeout(() => {
        if (state === session && session.selection === selection) {
          logFailure("selector", new Error("Selection timed out"));
          cancelSelection();
        }
      }, session.config.selector.timeoutMs) };
      session.selection = selection;
      void deps.select(selectorPrompt(prompt, session.previousAssistant, candidates), ctx, session.config, controller.signal)
        .then((output) => {
          if (state !== session || session.selection !== selection || controller.signal.aborted) return;
          selection.ready = selectedTopics(output, candidates);
          clearTimeout(selection.timer);
          for (const topic of selection.ready) appendUsageEvent(session.config.stateDir, {
            ts: deps.now().toISOString(), kind: "selected", topic: topic.name, session: session.sessionId, mode: session.config.selector.mode,
          });
        }).catch((error) => {
          if (state !== session || session.selection !== selection) return;
          logFailure("selector", error);
          cancelSelection();
        });
    }

    function buildJob(session: SessionState, ctx: SessionView, sessionFile: string, force: boolean, trigger: WriterTrigger): WriterJob {
      return {
        config: session.config,
        sessionFile,
        sessionId: session.sessionId,
        cwd: ctx.cwd,
        packageRoot: deps.packageRoot,
        force,
        trigger,
        endEntryId: ctx.sessionManager.getLeafId() ?? undefined,
        createdAt: deps.now().toISOString(),
      };
    }

    function showProposalWidget(session: SessionState, ctx: Pick<ExtensionContext, "ui">, withNotice: boolean): void {
      const proposals = readProposals(session.config.dir);
      const proposalState = loadPrunedState(session.config, proposals);
      const pending = pendingProposals(proposals, proposalState, deps.now()).length;
      const failed = failedApplies(proposals, proposalState, deps.now()).length;
      const lastApply = readLastRun(session.config.stateDir, "apply");
      const notice = withNotice ? applyNotice(lastApply, proposalState) : null;
      const line = proposalWidgetLine(pending, notice, failed);
      ctx.ui.setWidget(PROPOSALS_WIDGET, line === null ? undefined : [line]);
      session.widgetClearsOnInput = line !== null;
      if (notice && lastApply) updateProposalState(session.config.stateDir, (current) => (current.applyNoticeShown = lastApply.ts));
    }

    function retryApprovedProposals(session: SessionState, ctx: Pick<ExtensionContext, "cwd">): void {
      const config = session.config;
      const proposals = readProposals(config.dir);
      const now = deps.now();
      const retry = retryableProposals(proposals, loadPrunedState(config, proposals), now);
      if (retry.length === 0) return;
      const state = updateProposalState(config.stateDir, (current) => {
        for (const proposal of retry) markApplying(current, proposal.id, now, "retry");
      });
      try {
        deps.enqueue({
          kind: "apply",
          config,
          sessionId: session.sessionId,
          cwd: ctx.cwd,
          packageRoot: deps.packageRoot,
          createdAt: now.toISOString(),
          proposals: retry.map((proposal) => ({
            id: proposal.id,
            skill: proposal.skill,
            rule: proposal.rule,
            why: proposal.why,
            evidence: proposal.evidence,
            comment: state.proposals[proposal.id]?.comment ?? "",
          })),
        });
      } catch (error) {
        updateProposalState(config.stateDir, (current) => {
          for (const proposal of retry) updateNote(current, proposal.id, { applyingSince: undefined });
        });
        logFailure("retrying approved proposals", error);
      }
    }

    function clearProposalWidget(session: SessionState, ctx: Pick<ExtensionContext, "ui">): void {
      session.widgetClearsOnInput = false;
      ctx.ui.setWidget(PROPOSALS_WIDGET, undefined);
    }

    pi.on("session_start", (event, ctx) => {
      try {
        const session = startSession(ctx);
        if (event.reason === "startup" && ctx.mode === "tui") {
          if (!shouldSkipWrite(session.config, deps.env)) {
            void recoverableSessions(session.config, session.sessionId, deps.now()).then((sessions) => {
              for (const recovered of sessions) deps.enqueue({
                ...buildJob(session, ctx, recovered.sessionFile, false, "recovery"), ...recovered,
              });
            }).catch((error) => logFailure("recovery", error));
          }
          retryApprovedProposals(session, ctx);
          showProposalWidget(session, ctx, true);
        }
      } catch (error) {
        logFailure("session_start", error);
      }
    });

    pi.on("resources_discover", (event: ResourcesDiscoverEvent, ctx): ResourcesDiscoverResult | undefined => {
      try {
        const session = current(ctx);
        session.topics = listTopics(session.config.dir);
        const cwd = resolve(event.cwd);
        const identity = deps.resolver.resolvePath(cwd)?.identity ?? null;
        const discovered = topicsForRepo(session.topics, identity);
        listed = discovered.map((topic) => ({
          name: topic.name,
          reason:
            topic.scope === "generic"
              ? "generic topic, listed in every repository"
              : `scoped to ${identity}, the repository containing ${cwd}`,
        }));
        if (discovered.length === 0) return undefined;
        return { skillPaths: discovered.map((topic) => topic.path) };
      } catch (error) {
        logFailure("resources_discover", error);
        return undefined;
      }
    });

    pi.on("tool_call", (event: ToolCallEvent, ctx) => {
      try {
        const session = current(ctx);
        const dir = session.config.dir;
        const lines: string[] = [];
        for (const path of extractToolPaths(event.toolName, event.input, ctx.cwd, deps.home)) {
          if (isInside(path, dir)) {
            const topic = event.toolName === "read" ? memoryTopicOfPath(path, dir) : null;
            if (topic && !session.loaded.has(topic)) {
              session.loaded.add(topic);
              recordUsage(session, "loaded", topic);
            }
            continue;
          }
          const identity = deps.resolver.resolvePath(path)?.identity;
          if (!identity) continue;
          const line = announce(session, identity, `${event.toolName} touched ${path}`);
          if (line) lines.push(line);
        }
        if (lines.length > 0) session.pending.set(event.toolCallId, [...(session.pending.get(event.toolCallId) ?? []), ...lines]);
      } catch (error) {
        logFailure("tool_call", error);
      }
      return undefined;
    });

    pi.on("tool_result", (event: ToolResultEvent): ToolResultEventResult | undefined => {
      try {
        const lines = state?.pending.get(event.toolCallId);
        if (!state || !lines) return undefined;
        state.pending.delete(event.toolCallId);
        return {
          content: [...event.content, { type: "text", text: lines.join("\n") }],
          structuredContent: event.structuredContent,
        };
      } catch (error) {
        logFailure("tool_result", error);
        return undefined;
      }
    });

    pi.on("input", (event: InputEvent, ctx: ModeView & Pick<ExtensionContext, "ui">) => {
      try {
        const session = current(ctx);
        if (session.widgetClearsOnInput) {
          session.widgetClearsOnInput = false;
          ctx.ui.setWidget(PROPOSALS_WIDGET, undefined);
        }
        rememberInput(session.pendingInputs, {
          text: event.text,
          source: event.source,
          mode: ctx.mode,
          streamingBehavior: event.streamingBehavior,
        });
      } catch (error) {
        logFailure("input", error);
      }
      return undefined;
    });

    pi.on("message_start", (event: MessageStartEvent, ctx) => {
      try {
        const message = event.message as { role?: unknown; content?: unknown; timestamp?: unknown };
        if (message.role !== "user" || typeof message.timestamp !== "number") return;
        const input = takeInputFor(current(ctx).pendingInputs, messageText(message.content));
        if (!input) return;
        const mark: InputMark = { messageTimestamp: message.timestamp, source: input.source, mode: input.mode };
        pi.appendEntry(INPUT_MARK_TYPE, mark);
      } catch (error) {
        logFailure("message_start", error);
      }
    });

    pi.on("message_end", (event) => {
      if (state && event.message.role === "assistant") state.previousAssistant = messageText(event.message.content).slice(-2000);
    });

    pi.on("context", (event) => {
      if (!state) return;
      const session = state;
      let remaining = session.config.selector.maxChars;
      let delivered = 0;
      const ready = session.selection?.ready.splice(0) ?? [];
      for (const topic of ready) {
        if (session.loaded.has(topic.name) || session.pointed.has(topic.name)) continue;
        try {
          const separatorChars = delivered > 0 ? 2 : 0;
          const text = topicDelivery(topic, session.config.selector.mode, remaining - separatorChars);
          if (!text) continue;
          remaining -= text.length + separatorChars;
          delivered++;
          session.contextMemory.push(text);
          if (session.config.selector.mode === "inject") session.loaded.add(topic.name);
          else session.pointed.add(topic.name);
          appendUsageEvent(session.config.stateDir, {
            ts: deps.now().toISOString(), kind: "injected", topic: topic.name, session: session.sessionId, mode: session.config.selector.mode,
          });
        } catch (error) { logFailure("selector delivery", error); }
      }
      if (session.contextMemory.length === 0) return;
      return { messages: [...event.messages, {
        role: "custom" as const, customType: "pi-skill-memory-selection", content: session.contextMemory.join("\n\n"),
        display: false, timestamp: deps.now().getTime(),
      }] };
    });

    pi.on("agent_end", cancelSelection);

    pi.on("agent_settled", () => {
      cancelSelection();
      if (state) state.pendingInputs.length = 0;
    });

    function queueSession(session: SessionState, ctx: SessionView, trigger: WriterTrigger): EnqueueResult | undefined {
      const force = trigger === "manual";
      if (!force && shouldSkipWrite(session.config, deps.env)) return;
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) return;
      const branch = ctx.sessionManager.getBranch();
      const completed = processedEntryIds(session.config.stateDir, session.sessionId);
      const pending = session.manualWriteLeaf ? [...completed, session.manualWriteLeaf] : completed;
      const remaining = unprocessedEntries(branch, pending);
      const humans = countHumanMessages(remaining, session.config.learnFromSources);
      if (!force && (humans === 0 || humans < session.config.minUserMessages)) return;
      if (session.manualWriteLeaf !== undefined && session.manualWriteLeaf === ctx.sessionManager.getLeafId()) return;
      const job = buildJob(session, ctx, sessionFile, force, trigger);
      const result = deps.enqueue(job);
      pi.appendEntry(WATERMARK_TYPE, { processedEntryIds: completed, queuedThrough: job.endEntryId, trigger });
      session.manualWriteLeaf = ctx.sessionManager.getLeafId();
      return result;
    }

    pi.on("session_before_compact", (_event, ctx) => {
      try {
        const session = current(ctx);
        if (session.config.flushBeforeCompaction) queueSession(session, ctx, "compaction");
      } catch (error) { logFailure("session_before_compact", error); }
    });

    pi.on("session_compact", () => {
      cancelSelection();
      state?.announced.clear();
      state?.loaded.clear();
      state?.pointed.clear();
      if (state) state.contextMemory = [];
    });

    pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx): BeforeAgentStartEventResult | undefined => {
      try {
        const session = current(ctx);
        beginSelection(session, event.prompt, ctx);
        const skillsInstruction = session.skillsInstruction;
        if (session.userMemory || skillsInstruction) {
          event.systemPromptOptions.sections = {
            ...event.systemPromptOptions.sections,
            [USER_MEMORY_SECTION]: userMemorySection(session.userMemory ?? "", skillsInstruction),
          };
        }
        const lines: string[] = [];
        for (const match of promptNamedRepos(event.prompt, knownRepoIdentities(session.topics))) {
          const line = announce(session, match.identity, `prompt mentioned "${match.matched}"`);
          if (line) lines.push(line);
        }
        if (lines.length === 0) return undefined;
        return { message: { customType: REMINDER_MESSAGE_TYPE, content: lines.join("\n"), display: false } };
      } catch (error) {
        logFailure("before_agent_start", error);
        return undefined;
      }
    });

    pi.on("session_shutdown", (event: SessionShutdownEvent, ctx) => {
      try {
        if (event.reason === "reload") return;
        const session = current(ctx);
        queueSession(session, ctx, "shutdown");
      } catch (error) {
        logFailure("session_shutdown", error);
      } finally {
        cancelSelection();
        state = null;
      }
    });

    function notify(ctx: ExtensionCommandContext, text: string, level: "info" | "warning" | "error" = "info"): void {
      ctx.ui.notify(text, level);
      if (!ctx.hasUI) process.stdout.write(`${text}\n`);
    }

    function runStatus(session: SessionState, ctx: ExtensionCommandContext): void {
      const topics = listTopics(session.config.dir);
      const text = formatStatus({
        config: session.config,
        topics,
        userMemoryChars: readUserMemory(session.config.dir)?.length ?? 0,
        lastRun: readLastRun(session.config.stateDir),
        lastApply: readLastRun(session.config.stateDir, "apply"),
        pueuePath: deps.which("pueue"),
      });
      notify(ctx, text);
    }

    function skillSource(session: SessionState, ctx: ExtensionCommandContext): (skill: string) => SkillSource | null {
      const index = readSkillIndex(skillIndexRoots({ agentDir: session.config.agentDir, home: deps.home, cwd: ctx.cwd }), session.config.dir);
      return (skill) => {
        const entry = index.find((candidate) => candidate.name === skill);
        if (!entry) return null;
        try {
          return { path: entry.path, text: readFileSync(entry.path, "utf8") };
        } catch {
          return null;
        }
      };
    }

    function displayPath(path: string): string {
      const fromHome = relative(deps.home, path);
      return fromHome.startsWith("..") ? path : `~/${fromHome}`;
    }

    async function runProposals(session: SessionState, ctx: ExtensionCommandContext): Promise<void> {
      const config = session.config;
      if (!ctx.hasUI) {
        const proposals = readProposals(config.dir);
        notify(ctx, formatProposalList(pendingProposals(proposals, loadPrunedState(config, proposals), deps.now())));
        return;
      }
      if (ctx.mode === "tui") {
        const code = await deps.runReviewApp(config, ctx);
        const proposals = readProposals(config.dir);
        const remaining = pendingProposals(proposals, loadPrunedState(config, proposals), deps.now()).length;
        clearProposalWidget(session, ctx);
        if (code !== 0) notify(ctx, `pi-memory review exited with code ${code}; is fzf installed?`, "warning");
        else notify(ctx, `${remaining} memory proposal${remaining === 1 ? "" : "s"} pending.`);
        return;
      }
      const lookup = skillSource(session, ctx);
      const outcome = await reviewProposals(dialogReviewUI(ctx), {
        config,
        now: deps.now,
        skillFor: (skill) => {
          const source = lookup(skill);
          return source ? { ...source, path: displayPath(source.path) } : null;
        },
        discard: async (proposal) => {
          await discardProposal(config.dir, proposal, { autoCommit: config.autoCommit, lock: { timeoutMs: DISCARD_LOCK_TIMEOUT_MS } });
        },
        enqueueApply: (proposals: ApplyProposal[]) => {
          const result = deps.enqueue({
            kind: "apply",
            config,
            sessionId: session.sessionId,
            cwd: ctx.cwd,
            packageRoot: deps.packageRoot,
            createdAt: deps.now().toISOString(),
            proposals,
          });
          return `${result.runner} runner, job ${result.jobFile}`;
        },
      });
      const proposals = readProposals(config.dir);
      const remaining = pendingProposals(proposals, loadPrunedState(config, proposals), deps.now()).length;
      clearProposalWidget(session, ctx);
      notify(ctx, describeReview(outcome, remaining), outcome.errors.length > 0 ? "warning" : "info");
    }

    function runWrite(session: SessionState, ctx: ExtensionCommandContext): void {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        notify(ctx, "This session has no session file (--no-session), so there is nothing to write from.", "warning");
        return;
      }
      const result = queueSession(session, ctx, "manual");
      if (!result) { notify(ctx, "No new turns to write."); return; }
      notify(ctx, `Queued the memory writer for this session (${result.runner} runner, job ${result.jobFile}).`);
    }

    pi.registerCommand(COMMAND_NAME, {
      description: "Memory skills: status, explain, write, stats, redescribe",
      getArgumentCompletions: (prefix) => {
        const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        const subcommand = args.trim().split(/\s+/)[0] || "status";
        try {
          const session = current(ctx);
          if (subcommand === "status") runStatus(session, ctx);
          else if (subcommand === "stats") notify(ctx, formatStats(session.config, parseStatsArgs(args.trim().split(/\s+/).slice(1))));
          else if (subcommand === "redescribe") notify(ctx, await redescribe(session.config, parseRedescribeArgs(args.trim().split(/\s+/).slice(1))));
          else if (subcommand === "explain") notify(ctx, formatExplain(listed, session.reminders));
          else if (subcommand === "write") runWrite(session, ctx);
          else {
            notify(
              ctx,
              `Unknown subcommand "${subcommand}". Use /memory status, /memory stats, /memory explain, /memory redescribe or /memory write; review proposals with /proposals.`,
              "warning",
            );
          }
        } catch (error) {
          logFailure(`/memory ${subcommand}`, error);
          notify(ctx, `/memory ${subcommand} failed: ${errorMessage(error)}`, "error");
        }
      },
    });

    pi.registerCommand(PROPOSALS_COMMAND, {
      description: "Review memory proposals for your skills: apply, comment, discard or omit",
      handler: async (_args, ctx) => {
        try {
          await runProposals(current(ctx), ctx);
        } catch (error) {
          logFailure(`/${PROPOSALS_COMMAND}`, error);
          notify(ctx, `/${PROPOSALS_COMMAND} failed: ${errorMessage(error)}`, "error");
        }
      },
    });
  };
}

export default createExtension();
