import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type {
  BeforeAgentStartEvent,
  BeforeAgentStartEventResult,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  ResourcesDiscoverEvent,
  ResourcesDiscoverResult,
  SessionShutdownEvent,
  ToolCallEvent,
  ToolResultEvent,
  ToolResultEventResult,
} from "@earendil-works/pi-coding-agent";
import { formatExplain, formatStatus, type ListedTopic, type ReminderRecord } from "./commands.ts";
import { resolveConfig, shouldSkipWrite, type MemoryConfig } from "./config.ts";
import { extractToolPaths } from "./paths.ts";
import { knownRepoIdentities, promptNamedRepos, reminderLine, reminderTopics } from "./reminders.ts";
import { createRepoResolver, type RepoResolver } from "./repo.ts";
import { listTopics, topicsForRepo, type TopicSummary } from "./topics.ts";
import { appendUsageEvent } from "./usage.ts";
import { isInside } from "./writer/confine.ts";
import { enqueueWriter, findOnPath, type EnqueueResult, type Which } from "./writer/enqueue.ts";
import type { WriterJob } from "./writer/job.ts";
import { PACKAGE_ROOT } from "./writer/prompts.ts";
import { appendWriterLog, readLastRun } from "./writer/runs.ts";
import { memoryTopicOfPath } from "./writer/session.ts";

export const USER_MEMORY_SECTION = "user_memory";
export const USER_MEMORY_HEADING = "What this user wants from agents in every repository (pi-skill-memory user.md):";
export const REMINDER_MESSAGE_TYPE = "pi-skill-memory-reminder";
export const COMMAND_NAME = "memory";
export const SUBCOMMANDS = ["status", "explain", "write"] as const;

export interface ExtensionDeps {
  resolver: RepoResolver;
  enqueue: (job: WriterJob) => EnqueueResult;
  now: () => Date;
  env: Record<string, string | undefined>;
  home: string;
  packageRoot: string;
  which: Which;
}

interface SessionState {
  config: MemoryConfig;
  sessionId: string;
  userMemory: string | null;
  topics: TopicSummary[];
  announced: Set<string>;
  pending: Map<string, string[]>;
  reminders: ReminderRecord[];
  loaded: Set<string>;
  manualWriteLeaf: string | null | undefined;
}

type SessionView = Pick<ExtensionContext, "cwd" | "sessionManager">;

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

export function userMemorySection(snapshot: string): string {
  return `${USER_MEMORY_HEADING}\n\n${snapshot}`;
}

export function countUserMessages(entries: readonly unknown[]): number {
  let count = 0;
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as { type?: unknown; message?: { role?: unknown } };
    if (record.type === "message" && record.message?.role === "user") count++;
  }
  return count;
}

export function createExtension(overrides: Partial<ExtensionDeps> = {}): (pi: ExtensionAPI) => void {
  return function piSkillMemory(pi: ExtensionAPI): void {
    const which = overrides.which ?? findOnPath;
    const deps: ExtensionDeps = {
      resolver: overrides.resolver ?? createRepoResolver(),
      enqueue: overrides.enqueue ?? ((job) => enqueueWriter(job, { which })),
      now: overrides.now ?? (() => new Date()),
      env: overrides.env ?? process.env,
      home: overrides.home ?? homedir(),
      packageRoot: overrides.packageRoot ?? PACKAGE_ROOT,
      which,
    };
    let state: SessionState | null = null;
    let listed: ListedTopic[] = [];

    function startSession(ctx: SessionView): SessionState {
      const config = resolveConfig(pi.getSettings(), { env: deps.env, home: deps.home });
      state = {
        config,
        sessionId: ctx.sessionManager.getSessionId(),
        userMemory: readUserMemory(config.dir),
        topics: listTopics(config.dir),
        announced: new Set(),
        pending: new Map(),
        reminders: [],
        loaded: new Set(),
        manualWriteLeaf: undefined,
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
      if (session.announced.has(identity)) return null;
      const names = reminderTopics(session.topics, identity);
      if (names.length === 0) return null;
      session.announced.add(identity);
      session.reminders.push({ repo: identity, topics: names, trigger });
      for (const name of names) recordUsage(session, "reminded", name);
      return reminderLine(identity, names, session.config.dir);
    }

    function buildJob(session: SessionState, ctx: SessionView, sessionFile: string, force: boolean): WriterJob {
      return {
        config: session.config,
        sessionFile,
        sessionId: session.sessionId,
        cwd: ctx.cwd,
        packageRoot: deps.packageRoot,
        force,
        createdAt: deps.now().toISOString(),
      };
    }

    pi.on("session_start", (_event, ctx) => {
      try {
        startSession(ctx);
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

    pi.on("session_compact", () => {
      state?.announced.clear();
    });

    pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx): BeforeAgentStartEventResult | undefined => {
      try {
        const session = current(ctx);
        if (session.userMemory) {
          event.systemPromptOptions.sections = {
            ...event.systemPromptOptions.sections,
            [USER_MEMORY_SECTION]: userMemorySection(session.userMemory),
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
        if (shouldSkipWrite(session.config, deps.env)) return;
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) return;
        const branch = ctx.sessionManager.getBranch();
        if (countUserMessages(branch) < session.config.minUserMessages) return;
        if (session.manualWriteLeaf !== undefined && session.manualWriteLeaf === ctx.sessionManager.getLeafId()) return;
        deps.enqueue(buildJob(session, ctx, sessionFile, false));
      } catch (error) {
        logFailure("session_shutdown", error);
      } finally {
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
        pueuePath: deps.which("pueue"),
      });
      notify(ctx, text);
    }

    function runWrite(session: SessionState, ctx: ExtensionCommandContext): void {
      const sessionFile = ctx.sessionManager.getSessionFile();
      if (!sessionFile) {
        notify(ctx, "This session has no session file (--no-session), so there is nothing to write from.", "warning");
        return;
      }
      const result = deps.enqueue(buildJob(session, ctx, sessionFile, true));
      session.manualWriteLeaf = ctx.sessionManager.getLeafId();
      notify(ctx, `Queued the memory writer for this session (${result.runner} runner, job ${result.jobFile}).`);
    }

    pi.registerCommand(COMMAND_NAME, {
      description: "Memory skills: status, explain, write",
      getArgumentCompletions: (prefix) => {
        const items = SUBCOMMANDS.filter((name) => name.startsWith(prefix.trim())).map((name) => ({ value: name, label: name }));
        return items.length > 0 ? items : null;
      },
      handler: async (args, ctx) => {
        const subcommand = args.trim().split(/\s+/)[0] || "status";
        try {
          const session = current(ctx);
          if (subcommand === "status") runStatus(session, ctx);
          else if (subcommand === "explain") notify(ctx, formatExplain(listed, session.reminders));
          else if (subcommand === "write") runWrite(session, ctx);
          else notify(ctx, `Unknown subcommand "${subcommand}". Use /memory status, /memory explain or /memory write.`, "warning");
        } catch (error) {
          logFailure(`/memory ${subcommand}`, error);
          notify(ctx, `/memory ${subcommand} failed: ${errorMessage(error)}`, "error");
        }
      },
    });
  };
}

export default createExtension();
