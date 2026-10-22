import { readFileSync } from "node:fs";
import { join } from "node:path";
import { writeFileAtomic, type Proposal } from "./proposals.ts";

export const PROPOSAL_STATE_FILE = "proposals-state.json";
export const SNOOZE_MS = 24 * 60 * 60_000;
export const APPLYING_TTL_MS = 2 * 60 * 60_000;
export const MAX_APPLY_ATTEMPTS = 3;

export interface ProposalNote {
  comment?: string;
  snoozedUntil?: string;
  lastError?: string;
  applyingSince?: string;
  approvedAt?: string;
  attempts?: number;
  needsUser?: boolean;
}

type NoteChange = { [K in keyof ProposalNote]?: ProposalNote[K] | "" };

export interface ProposalState {
  proposals: Record<string, ProposalNote>;
  applyNoticeShown?: string;
}

export function proposalStatePath(stateDir: string): string {
  return join(stateDir, PROPOSAL_STATE_FILE);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readNote(value: unknown): ProposalNote | null {
  if (!isRecord(value)) return null;
  const note: ProposalNote = {};
  for (const key of ["comment", "snoozedUntil", "lastError", "applyingSince", "approvedAt"] as const) {
    const field = value[key];
    if (typeof field === "string" && field !== "") note[key] = field;
  }
  if (typeof value.attempts === "number" && Number.isInteger(value.attempts) && value.attempts > 0) note.attempts = value.attempts;
  if (value.needsUser === true) note.needsUser = true;
  return Object.keys(note).length > 0 ? note : null;
}

export function loadProposalState(stateDir: string): ProposalState {
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(proposalStatePath(stateDir), "utf8"));
  } catch {
    return { proposals: {} };
  }
  const state: ProposalState = { proposals: {} };
  if (!isRecord(data)) return state;
  if (isRecord(data.proposals)) {
    for (const [id, value] of Object.entries(data.proposals)) {
      const note = readNote(value);
      if (note) state.proposals[id] = note;
    }
  }
  if (typeof data.applyNoticeShown === "string") state.applyNoticeShown = data.applyNoticeShown;
  return state;
}

export function saveProposalState(stateDir: string, state: ProposalState): void {
  writeFileAtomic(proposalStatePath(stateDir), `${JSON.stringify(state, null, 2)}\n`);
}

export function updateProposalState(stateDir: string, mutate: (state: ProposalState) => void): ProposalState {
  const state = loadProposalState(stateDir);
  mutate(state);
  saveProposalState(stateDir, state);
  return state;
}

export function updateNote(state: ProposalState, id: string, change: NoteChange): void {
  const note: Record<string, unknown> = { ...state.proposals[id] };
  for (const [key, value] of Object.entries(change)) {
    if (value === undefined || value === "" || value === false) delete note[key];
    else note[key] = value;
  }
  if (Object.keys(note).length === 0) delete state.proposals[id];
  else state.proposals[id] = note as ProposalNote;
}

export function pruneProposalState(state: ProposalState, existing: Iterable<string>): boolean {
  const keep = new Set(existing);
  let changed = false;
  for (const id of Object.keys(state.proposals)) {
    if (keep.has(id)) continue;
    delete state.proposals[id];
    changed = true;
  }
  return changed;
}

function stillBefore(timestamp: string | undefined, now: Date): boolean {
  if (!timestamp) return false;
  const time = Date.parse(timestamp);
  return !Number.isNaN(time) && time > now.getTime();
}

export function isSnoozed(note: ProposalNote | undefined, now: Date): boolean {
  return stillBefore(note?.snoozedUntil, now);
}

export function isApplying(note: ProposalNote | undefined, now: Date): boolean {
  if (!note?.applyingSince) return false;
  const since = Date.parse(note.applyingSince);
  return !Number.isNaN(since) && now.getTime() - since < APPLYING_TTL_MS;
}

export function snooze(state: ProposalState, id: string, now: Date): void {
  updateNote(state, id, { snoozedUntil: new Date(now.getTime() + SNOOZE_MS).toISOString() });
}

export function needsAttention(note: ProposalNote | undefined, now: Date): boolean {
  if (!note?.approvedAt || isApplying(note, now)) return false;
  return note.needsUser === true || (note.attempts ?? 0) >= MAX_APPLY_ATTEMPTS;
}

export function isAwaitingRetry(note: ProposalNote | undefined, now: Date): boolean {
  return note?.approvedAt !== undefined && !isApplying(note, now) && !needsAttention(note, now);
}

export function markApplying(state: ProposalState, id: string, now: Date, approval: "user" | "retry"): void {
  const note = state.proposals[id];
  const since = now.toISOString();
  updateNote(state, id, {
    applyingSince: since,
    snoozedUntil: undefined,
    approvedAt: approval === "user" ? since : note?.approvedAt ?? since,
    attempts: approval === "user" ? 1 : (note?.attempts ?? 0) + 1,
    needsUser: undefined,
    lastError: approval === "user" ? undefined : note?.lastError,
  });
}

export function retryableProposals(proposals: Proposal[], state: ProposalState, now: Date): Proposal[] {
  return proposals.filter((proposal) => isAwaitingRetry(state.proposals[proposal.id], now));
}

export function failedApplies(proposals: Proposal[], state: ProposalState, now: Date): Proposal[] {
  return proposals.filter((proposal) => needsAttention(state.proposals[proposal.id], now));
}

export function pendingProposals(proposals: Proposal[], state: ProposalState, now: Date): Proposal[] {
  return proposals.filter((proposal) => {
    const note = state.proposals[proposal.id];
    return !isSnoozed(note, now) && !isApplying(note, now) && !isAwaitingRetry(note, now);
  });
}

export function snoozedProposals(proposals: Proposal[], state: ProposalState, now: Date): Proposal[] {
  return proposals.filter((proposal) => {
    const note = state.proposals[proposal.id];
    return isSnoozed(note, now) && !isApplying(note, now);
  });
}
