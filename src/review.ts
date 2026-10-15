import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { MemoryConfig } from "./config.ts";
import {
  loadProposalState,
  pendingProposals,
  pruneProposalState,
  saveProposalState,
  snooze,
  snoozedProposals,
  updateNote,
  updateProposalState,
  type ProposalState,
} from "./proposal-state.ts";
import { readProposals, type Proposal } from "./proposals.ts";
import { CARD_ACTIONS, PROPOSAL_ENTRY, proposalEntryData, type CardInput, type CardResult, type ProposalEntryData } from "./review-card.ts";
import type { ApplyProposal } from "./writer/job.ts";
import type { RunRecord } from "./writer/runs.ts";

export const PROPOSALS_WIDGET = "pi-skill-memory-proposals";
export const STOP_LABEL = "Stop reviewing";

export interface ReviewUI {
  card(input: CardInput): Promise<CardResult>;
}

export interface SkillSource {
  path: string;
  text: string;
}

export interface ReviewDeps {
  config: MemoryConfig;
  now: () => Date;
  skillFor: (skill: string) => SkillSource | null;
  discard: (proposal: Proposal) => Promise<void>;
  enqueueApply: (proposals: ApplyProposal[]) => string;
}

export interface ReviewOutcome {
  reviewed: number;
  queued: number;
  discarded: number;
  omitted: number;
  stopped: boolean;
  errors: string[];
  queuedWith: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function loadPrunedState(config: MemoryConfig, proposals: Proposal[]): ProposalState {
  const state = loadProposalState(config.stateDir);
  if (pruneProposalState(state, proposals.map((proposal) => proposal.id))) saveProposalState(config.stateDir, state);
  return state;
}

export function reviewQueue(proposals: Proposal[], state: ProposalState, now: Date): Proposal[] {
  const pending = pendingProposals(proposals, state, now);
  return pending.length > 0 ? pending : snoozedProposals(proposals, state, now);
}

export async function reviewProposals(ui: ReviewUI, deps: ReviewDeps): Promise<ReviewOutcome> {
  const { config } = deps;
  const proposals = readProposals(config.dir);
  let state = loadPrunedState(config, proposals);
  const queue = reviewQueue(proposals, state, deps.now());
  const outcome: ReviewOutcome = { reviewed: 0, queued: 0, discarded: 0, omitted: 0, stopped: false, errors: [], queuedWith: null };
  const approved: ApplyProposal[] = [];
  const skills = new Map<string, SkillSource | null>();
  const skillOf = (name: string) => {
    if (!skills.has(name)) skills.set(name, deps.skillFor(name));
    return skills.get(name)!;
  };
  review: for (const [index, proposal] of queue.entries()) {
    for (;;) {
      const note = state.proposals[proposal.id];
      const skill = skillOf(proposal.skill);
      const result = await ui.card({
        proposal,
        comment: note?.comment ?? "",
        lastError: note?.lastError ?? "",
        position: index + 1,
        total: queue.length,
        skillPath: skill?.path ?? null,
        skillText: skill?.text ?? null,
      });
      if (result.action === "stop") {
        outcome.stopped = true;
        break review;
      }
      if (result.action === "comment") {
        state = updateProposalState(config.stateDir, (current) => updateNote(current, proposal.id, { comment: result.comment || undefined }));
        continue;
      }
      outcome.reviewed++;
      if (result.action === "apply") {
        approved.push({
          id: proposal.id,
          skill: proposal.skill,
          rule: proposal.rule,
          why: proposal.why,
          evidence: proposal.evidence,
          comment: note?.comment ?? "",
        });
      } else if (result.action === "omit") {
        state = updateProposalState(config.stateDir, (current) => snooze(current, proposal.id, deps.now()));
        outcome.omitted++;
      } else {
        try {
          await deps.discard(proposal);
          state = updateProposalState(config.stateDir, (current) => {
            delete current.proposals[proposal.id];
          });
          outcome.discarded++;
        } catch (error) {
          outcome.errors.push(`discard ${proposal.skill}: ${errorMessage(error)}`);
        }
      }
      break;
    }
  }
  if (approved.length > 0) {
    const since = deps.now().toISOString();
    updateProposalState(config.stateDir, (current) => {
      for (const proposal of approved) updateNote(current, proposal.id, { applyingSince: since, snoozedUntil: undefined });
    });
    try {
      outcome.queuedWith = deps.enqueueApply(approved);
      outcome.queued = approved.length;
    } catch (error) {
      updateProposalState(config.stateDir, (current) => {
        for (const proposal of approved) updateNote(current, proposal.id, { applyingSince: undefined });
      });
      outcome.errors.push(`queueing the apply job failed: ${errorMessage(error)}`);
    }
  }
  return outcome;
}

export function describeReview(outcome: ReviewOutcome, remaining: number): string {
  const parts: string[] = [];
  if (outcome.queued > 0) {
    parts.push(`Queued ${outcome.queued} proposal${outcome.queued === 1 ? "" : "s"} for the background apply job (${outcome.queuedWith}); it commits each skill locally and never pushes.`);
  }
  const counts = [
    outcome.discarded > 0 ? `discarded ${outcome.discarded}` : "",
    outcome.omitted > 0 ? `omitted ${outcome.omitted} for 24 hours` : "",
  ].filter((part) => part !== "");
  if (counts.length > 0) parts.push(`${counts.join(", ")}.`.replace(/^./, (first) => first.toUpperCase()));
  if (outcome.reviewed === 0 && outcome.queued === 0) parts.push("No proposals reviewed.");
  parts.push(`${remaining} pending.`);
  for (const error of outcome.errors) parts.push(error);
  return parts.join(" ");
}

export function applyNotice(run: RunRecord | null, state: ProposalState): string | null {
  if (!run || !run.summary) return null;
  if (state.applyNoticeShown && Date.parse(state.applyNoticeShown) >= Date.parse(run.ts)) return null;
  return run.summary;
}

export function proposalWidgetLine(pending: number, notice: string | null): string | null {
  const last = notice ? `last apply: ${notice}` : null;
  if (pending > 0) {
    const head = `${pending} memory proposal${pending === 1 ? "" : "s"} — /memory proposals`;
    return last ? `${head} · ${last}` : head;
  }
  return last ? `memory proposals: ${last}` : null;
}

export function formatProposalList(proposals: Proposal[]): string {
  if (proposals.length === 0) return "No memory proposals pending.";
  return [
    `${proposals.length} memory proposals pending (review them in the terminal UI with /memory proposals):`,
    ...proposals.map((proposal) => `  ${proposal.id} ${proposal.skill}: ${proposal.rule}`),
  ].join("\n");
}

type CardContext = Pick<ExtensionContext, "ui">;

export type AppendEntry = (customType: string, data: ProposalEntryData) => void;

export function actionLabel(action: (typeof CARD_ACTIONS)[number]): string {
  return `${action.label} — ${action.description}`;
}

export function transcriptReviewUI(ctx: CardContext, appendEntry: AppendEntry): ReviewUI {
  const labels = [...CARD_ACTIONS.map(actionLabel), STOP_LABEL];
  let shown: string | null = null;
  return {
    card: async (input) => {
      if (shown !== input.proposal.id) {
        appendEntry(PROPOSAL_ENTRY, proposalEntryData(input));
        shown = input.proposal.id;
      }
      const note = input.comment.trim() === "" ? "" : ` · comment: ${input.comment.trim()}`;
      const choice = await ctx.ui.select(`Proposal ${input.position}/${input.total} for ${input.proposal.skill}${note} (scroll up to read it)`, labels);
      const action = CARD_ACTIONS.find((candidate) => actionLabel(candidate) === choice);
      if (!action) return { action: "stop" };
      if (action.value !== "comment") return { action: action.value };
      const comment = await ctx.ui.editor(`Comment for the apply job on ${input.proposal.skill}`, input.comment);
      return { action: "comment", comment: comment === undefined ? input.comment : comment.trim() };
    },
  };
}

export function dialogCardTitle(input: CardInput): string {
  const lines = [
    `Memory proposal ${input.position}/${input.total} for ${input.proposal.skill} (${input.proposal.date})`,
    `Rule: ${input.proposal.rule}`,
    `Why: ${input.proposal.why}`,
  ];
  if (input.proposal.evidence !== "") lines.push(`Evidence: "${input.proposal.evidence}"`);
  if (input.comment.trim() !== "") lines.push(`Comment: ${input.comment.trim()}`);
  if (input.lastError !== "") lines.push(`Last apply: ${input.lastError}`);
  if (input.skillPath) lines.push(`Skill: ${input.skillPath}`);
  return lines.join("\n");
}

export function dialogReviewUI(ctx: CardContext): ReviewUI {
  const labels = [...CARD_ACTIONS.map((action) => action.label), STOP_LABEL];
  return {
    card: async (input) => {
      const choice = await ctx.ui.select(dialogCardTitle(input), labels);
      const action = CARD_ACTIONS.find((candidate) => candidate.label === choice);
      if (!action) return { action: "stop" };
      if (action.value !== "comment") return { action: action.value };
      const comment = await ctx.ui.editor(`Comment for the apply job on ${input.proposal.skill}`, input.comment);
      return comment === undefined ? { action: "comment", comment: input.comment } : { action: "comment", comment: comment.trim() };
    },
  };
}
