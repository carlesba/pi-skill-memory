import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, basename } from "node:path";
import {
  emptyLedger,
  isoDate,
  loadLedger,
  mintId,
  recordVote,
  reserveIdsAbove,
  saveLedger,
  sweepLedger,
  type Ledger,
} from "../ledger.ts";
import type { RepoResolver } from "../repo.ts";
import { readSkillIndex, skillIndexRoots } from "../skill-index.ts";
import {
  listTopics,
  memoryIds,
  mintTopicName,
  parseTopic,
  serializeMemories,
  serializeTopic,
  topicBaseName,
  withoutMemories,
  type Memory,
  type Scope,
} from "../topics.ts";
import { foldEventsIntoLedgers, foldUsageLog, readUsageEvents, topicsLoadedInSession, type FoldOptions } from "../usage.ts";
import {
  closestTopic,
  isScopeAtCap,
  memoryWeight,
  selectMemoryEvictions,
  selectStaleTopics,
  selectTopicEvictions,
  topicWeight,
} from "../weights.ts";
import { buildCommitMessage, commitMemory, runGit, type CommitSummary, type GitExec } from "./commit.ts";
import { confinedPath, confinedTopicPath } from "./confine.ts";
import type { WriterJob } from "./job.ts";
import { extractJson, type ModelRunner } from "./model.ts";
import {
  buildExtractPrompt,
  buildMergePrompt,
  buildUserMergePrompt,
  loadPrompt,
  PACKAGE_ROOT,
  type MergeCandidate,
} from "./prompts.ts";
import type { RunOutcomeKind } from "./runs.ts";
import { readSession } from "./session.ts";
import { validateExtract, validateMerge, validateUserMerge, type Candidate, type Removal } from "./validate.ts";

export interface PipelineDeps {
  model: ModelRunner;
  now?: () => Date;
  resolver?: RepoResolver;
  git?: GitExec;
  log?: (line: string) => void;
  home?: string;
  fold?: FoldOptions;
}

export interface PipelineResult {
  outcome: RunOutcomeKind;
  topics: string[];
  error?: string;
  rejected: string[];
  committed: boolean;
}

interface TopicState {
  name: string;
  scope: Scope;
  description: string;
  memories: Memory[];
  ledger: Ledger;
  isNew: boolean;
  bodyChanged: boolean;
  ledgerChanged: boolean;
  merged: boolean;
  needsMerge: boolean;
  flags: Set<string>;
  candidates: MergeCandidate[];
}

const USER_FILE = "user.md";
const PROPOSALS_FILE = "proposals.md";
const IGNORED_FLAG = "an ignored vote shows agents miss this topic when it applies; reword the description so it loads at that moment";

function writeAtomic(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, content);
  renameSync(temporary, path);
}

function readOptional(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadTopics(dir: string): Map<string, TopicState> {
  const topics = new Map<string, TopicState>();
  for (const summary of listTopics(dir)) {
    const name = basename(dirname(summary.path));
    let skillPath: string;
    try {
      skillPath = confinedTopicPath(dir, name, "SKILL.md");
    } catch {
      continue;
    }
    const parsed = parseTopic(readOptional(skillPath));
    if (!parsed) continue;
    const ledger = loadLedger(confinedTopicPath(dir, name, "ledger.json"));
    const bodyIds = memoryIds(serializeMemories(parsed.memories));
    reserveIdsAbove(ledger, bodyIds);
    for (const id of bodyIds) ledger.memories[id] ??= { source: "", learned: "", votes: [] };
    topics.set(name, {
      name,
      scope: parsed.scope,
      description: parsed.description,
      memories: parsed.memories,
      ledger,
      isNew: false,
      bodyChanged: false,
      ledgerChanged: false,
      merged: false,
      needsMerge: false,
      flags: new Set(),
      candidates: [],
    });
  }
  return topics;
}

function toMergeCandidate(candidate: Candidate): MergeCandidate {
  return { rule: candidate.rule, why: candidate.why, evidence: candidate.evidence };
}

export async function runPipeline(job: WriterJob, deps: PipelineDeps): Promise<PipelineResult> {
  const config = job.config;
  const dir = config.dir;
  const now = deps.now?.() ?? new Date();
  const log = deps.log ?? (() => undefined);
  const git = deps.git ?? runGit;
  const home = deps.home ?? homedir();
  const packageRoot = job.packageRoot || PACKAGE_ROOT;
  const rejected: string[] = [];
  const removed: CommitSummary["removed"] = [];
  const deletedTopics: CommitSummary["deletedTopics"] = [];
  const proposals: string[] = [];
  let userChanged = false;

  const topics = loadTopics(dir);
  const sameScope = (scope: Scope, except?: string) =>
    [...topics.values()].filter((topic) => topic.scope === scope && topic.name !== except);
  const saveTopicLedger = (topic: TopicState) => {
    sweepLedger(topic.ledger, memoryIds(serializeMemories(topic.memories)));
    saveLedger(confinedTopicPath(dir, topic.name, "ledger.json"), topic.ledger);
  };

  const folded = foldUsageLog(
    config.stateDir,
    (events) => {
      const touched = foldEventsIntoLedgers(events, (name) => topics.get(name)?.ledger ?? null);
      for (const name of touched) {
        const topic = topics.get(name)!;
        topic.ledgerChanged = true;
        saveTopicLedger(topic);
      }
    },
    deps.fold,
  );

  const finish = (outcome: RunOutcomeKind, error?: string): PipelineResult => {
    const touchedTopics = new Set<string>();
    for (const topic of topics.values()) {
      if (!topic.bodyChanged && !topic.ledgerChanged) continue;
      if (topic.bodyChanged && topic.memories.length === 0) {
        deleteTopic(topic.name, topic.isNew ? null : "no memories left");
        continue;
      }
      if (topic.bodyChanged) {
        writeAtomic(
          confinedTopicPath(dir, topic.name, "SKILL.md"),
          serializeTopic({
            name: topic.name,
            description: topic.description,
            scope: topic.scope,
            updated: isoDate(now),
            memories: topic.memories,
          }),
        );
        touchedTopics.add(topic.name);
      }
      saveTopicLedger(topic);
    }
    for (const entry of deletedTopics) touchedTopics.add(entry.topic);
    const changedContent = touchedTopics.size > 0 || userChanged || proposals.length > 0;
    const changedAnything = changedContent || [...topics.values()].some((topic) => topic.ledgerChanged);
    let committed = false;
    if (config.autoCommit && changedAnything) {
      const message = buildCommitMessage({
        topics: [...touchedTopics].sort(),
        userMemory: userChanged,
        proposals,
        removed,
        deletedTopics,
      });
      const result = commitMemory(dir, message, git);
      committed = result.committed;
      log(result.committed ? "committed memory changes" : `no commit: ${result.reason}`);
    }
    const finalOutcome = outcome === "nothing" && changedContent ? "ok" : outcome;
    return { outcome: finalOutcome, topics: [...touchedTopics].sort(), error, rejected, committed };
  };

  function deleteTopic(name: string, why: string | null): void {
    rmSync(confinedTopicPath(dir, name), { recursive: true, force: true });
    topics.delete(name);
    if (why !== null) deletedTopics.push({ topic: name, why });
  }

  const digest = readSession(job.sessionFile, { dir, resolver: deps.resolver, home });
  const sessionId = job.sessionId || digest.sessionId;
  if (!job.force && digest.turns.length < config.minUserMessages) {
    log(`skipped: ${digest.turns.length} user messages, fewer than ${config.minUserMessages}`);
    return finish("skipped");
  }

  const loadedNames = new Set(
    [...topicsLoadedInSession([...folded, ...readUsageEvents(config.stateDir)], sessionId), ...digest.memoryReads].filter((name) =>
      topics.has(name),
    ),
  );
  const userPath = confinedPath(dir, USER_FILE);
  const userMemory = readOptional(userPath);
  const skills = readSkillIndex(skillIndexRoots({ agentDir: config.agentDir, home, cwd: job.cwd || digest.cwd }), dir);
  const extractPrompt = buildExtractPrompt(
    {
      repos: digest.repos,
      userMemory,
      topics: [...topics.values()].map((topic) => ({ name: topic.name, description: topic.description, scope: topic.scope })),
      skills,
      loadedTopics: [...loadedNames].sort().map((name) => {
        const topic = topics.get(name)!;
        return { name, description: topic.description, scope: topic.scope, memories: topic.memories };
      }),
      turns: digest.turns,
    },
    loadPrompt("extract", packageRoot),
  );

  let pass1: ReturnType<typeof validateExtract>;
  try {
    pass1 = validateExtract(extractJson(await deps.model(extractPrompt)), {
      topicNames: new Set(topics.keys()),
      skillNames: new Set(skills.map((skill) => skill.name)),
      memoryIdsOf: (name) => {
        const topic = topics.get(name);
        return topic ? new Set(memoryIds(serializeMemories(topic.memories))) : null;
      },
    });
  } catch (error) {
    log(`pass 1 failed: ${errorMessage(error)}`);
    return finish("failed", `pass 1: ${errorMessage(error)}`);
  }
  if (!pass1.ok) {
    log(`pass 1 rejected: ${pass1.error}`);
    return finish("failed", `pass 1 rejected: ${pass1.error}`);
  }
  for (const vote of pass1.dropped) log(`dropped vote on unknown memory ${vote}`);

  for (const vote of pass1.votes) {
    const topic = topics.get(vote.topic)!;
    const outcome = recordVote(topic.ledger, vote.id, vote.kind, now);
    if (outcome === "unknown") {
      log(`dropped vote on unknown memory ${vote.topic}#${vote.id}`);
      continue;
    }
    topic.ledgerChanged = true;
    if (outcome === "retracted") {
      topic.memories = withoutMemories(topic.memories, [vote.id]);
      topic.bodyChanged = true;
      removed.push({ topic: topic.name, id: vote.id, why: "retracted by the user" });
    }
    if (vote.kind === "ignored") {
      topic.flags.add(IGNORED_FLAG);
      topic.needsMerge = true;
    }
  }

  const userCandidates: MergeCandidate[] = [];
  const proposalCandidates: Candidate[] = [];
  const caps = { maxGenericTopics: config.maxGenericTopics, maxTopicsPerRepo: config.maxTopicsPerRepo };
  const routeTo = (topic: TopicState, candidate: Candidate) => {
    topic.candidates.push(toMergeCandidate(candidate));
    topic.needsMerge = true;
  };
  for (const candidate of pass1.candidates) {
    const target = candidate.target;
    if (target.kind === "user") {
      userCandidates.push(toMergeCandidate(candidate));
    } else if (target.kind === "proposal") {
      proposalCandidates.push(candidate);
    } else if (target.kind === "topic") {
      routeTo(topics.get(target.name)!, candidate);
    } else {
      const existing = [...topics.values()].map((topic) => ({ name: topic.name, scope: topic.scope }));
      const same = topics.get(topicBaseName(candidate.scope, target.slug, existing));
      if (same && same.scope === candidate.scope) {
        routeTo(same, candidate);
        continue;
      }
      if (isScopeAtCap(existing, candidate.scope, caps)) {
        const closest = closestTopic(
          `${candidate.rule} ${candidate.why}`,
          sameScope(candidate.scope).map((topic) => ({
            name: topic.name,
            description: topic.description,
            weight: topicWeight(topic.ledger, now, config.halfLifeDays),
          })),
        );
        if (!closest) {
          log(`dropped candidate for new:${target.slug}: scope ${candidate.scope} is at its cap and has no topics`);
          continue;
        }
        log(`scope ${candidate.scope} is at its cap; new:${target.slug} goes to ${closest.name}`);
        routeTo(topics.get(closest.name)!, candidate);
        continue;
      }
      const name = mintTopicName(candidate.scope, target.slug, existing);
      const created: TopicState = {
        name,
        scope: candidate.scope,
        description: "",
        memories: [],
        ledger: emptyLedger(now.toISOString()),
        isNew: true,
        bodyChanged: false,
        ledgerChanged: false,
        merged: false,
        needsMerge: false,
        flags: new Set(),
        candidates: [],
      };
      topics.set(name, created);
      routeTo(created, candidate);
    }
  }

  const mergeTemplate = loadPrompt("merge", packageRoot);
  const merge = async (topic: TopicState, candidates: MergeCandidate[]): Promise<boolean> => {
    const prompt = buildMergePrompt(
      {
        name: topic.name,
        scope: topic.scope,
        description: topic.description,
        memories: topic.memories.map((memory) => ({
          id: memory.id ?? "new",
          text: memory.text,
          weight: memory.id ? memoryWeight(topic.ledger.memories[memory.id], now, config.halfLifeDays) : 0,
          learned: memory.id ? (topic.ledger.memories[memory.id]?.learned ?? "") : "",
        })),
        candidates,
        descriptionFlags: [...topic.flags],
        relatedTopics: sameScope(topic.scope, topic.name).map((other) => ({
          name: other.name,
          description: other.description,
          scope: other.scope,
        })),
        maxCharsPerTopic: config.maxCharsPerTopic,
        maxMemoriesPerTopic: config.maxMemoriesPerTopic,
      },
      mergeTemplate,
    );
    let result: ReturnType<typeof validateMerge>;
    try {
      result = validateMerge(extractJson(await deps.model(prompt)), {
        knownIds: new Set(Object.keys(topic.ledger.memories)),
        maxCharsPerTopic: config.maxCharsPerTopic,
      });
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    }
    if (!result.ok) {
      rejected.push(`${topic.name}: ${result.error}`);
      log(`pass 2 rejected for ${topic.name}: ${result.error}`);
      return false;
    }
    topic.description = result.description;
    topic.memories = result.memories.map((memory) =>
      memory.id === "new" ? { id: mintId(topic.ledger, sessionId, now), text: memory.text } : memory,
    );
    for (const entry of result.removed) removed.push({ topic: topic.name, id: entry.id, why: entry.why });
    if (result.split) log(`${topic.name} could split: ${result.split}`);
    const evicted = selectMemoryEvictions(
      topic.ledger,
      memoryIds(serializeMemories(topic.memories)),
      config.maxMemoriesPerTopic,
      now,
      config,
    );
    if (evicted.length > 0) {
      topic.memories = withoutMemories(topic.memories, evicted);
      for (const id of evicted) removed.push({ topic: topic.name, id, why: "evicted at the memory cap, lowest weight" });
    }
    topic.bodyChanged = true;
    topic.ledgerChanged = true;
    topic.merged = true;
    return true;
  };

  for (const topic of [...topics.values()].sort((a, b) => a.name.localeCompare(b.name))) {
    if (!topic.needsMerge) continue;
    const accepted = await merge(topic, topic.candidates);
    if (!accepted && topic.isNew) topics.delete(topic.name);
  }

  if (userCandidates.length > 0) {
    let result: ReturnType<typeof validateUserMerge>;
    try {
      const prompt = buildUserMergePrompt(
        { userMemory, candidates: userCandidates, maxUserChars: config.maxUserChars },
        loadPrompt("merge-user", packageRoot),
      );
      result = validateUserMerge(extractJson(await deps.model(prompt)), config.maxUserChars);
    } catch (error) {
      result = { ok: false, error: errorMessage(error) };
    }
    if (result.ok) {
      writeAtomic(userPath, result.body === "" ? "" : `${result.body}\n`);
      userChanged = true;
      for (const entry of result.removed) removed.push({ topic: USER_FILE, id: entry.id, why: entry.why });
    } else {
      rejected.push(`${USER_FILE}: ${result.error}`);
      log(`user.md merge rejected: ${result.error}`);
    }
  }

  if (proposalCandidates.length > 0) {
    const path = confinedPath(dir, PROPOSALS_FILE);
    const date = isoDate(now);
    const text = proposalCandidates
      .map((candidate) => {
        const skill = (candidate.target as { skill: string }).skill;
        proposals.push(skill);
        return `## ${date} proposal:${skill}\n\n- Rule: ${candidate.rule}\n- Why: ${candidate.why}\n- Evidence: "${candidate.evidence}"\n- Session: ${sessionId}\n`;
      })
      .join("\n");
    mkdirSync(dirname(path), { recursive: true });
    const prefix = existsSync(path) && readOptional(path).trim() !== "" ? "\n" : "";
    appendFileSync(path, `${prefix}${text}`);
  }

  const weighted = () =>
    [...topics.values()].map((topic) => ({ name: topic.name, scope: topic.scope, ledger: topic.ledger }));
  const staleNames = selectStaleTopics(
    weighted().filter((topic) => !topics.get(topic.name)!.merged && !topics.get(topic.name)!.isNew),
    now,
    config,
  );
  for (const name of staleNames) {
    const stale = topics.get(name);
    if (!stale) continue;
    const neighbours = sameScope(stale.scope, name).filter((topic) => !staleNames.includes(topic.name));
    const closest = closestTopic(
      [stale.description, ...stale.memories.map((memory) => memory.text)].join(" "),
      neighbours.map((topic) => ({
        name: topic.name,
        description: topic.description,
        weight: topicWeight(topic.ledger, now, config.halfLifeDays),
      })),
    );
    const carried = stale.memories.map((memory) => ({
      rule: memory.text,
      why: `carried over from stale topic ${name}`,
      evidence: "",
    }));
    if (closest && closest.similarity > 0 && carried.length > 0) {
      const accepted = await merge(topics.get(closest.name)!, carried);
      if (!accepted) continue;
      deleteTopic(name, `stale, merged into ${closest.name}`);
    } else {
      deleteTopic(name, `stale, no loaded vote in ${config.staleTopicDays} days`);
    }
  }

  for (const name of selectTopicEvictions(weighted(), caps, now, config)) {
    deleteTopic(name, "evicted at the scope cap, lowest weight");
  }

  return finish(pass1.votes.length > 0 ? "ok" : "nothing");
}
