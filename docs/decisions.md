# Decisions

Record each change to the extension with its hypothesis, the metric that will judge it, its baseline, and a review date. At review, compare against the recorded data rather than impressions; fill the outcome without rewriting the original hypothesis. The success criterion is that memories are used in future sessions: applied votes and loads in relevant sessions, with fewer confirmed votes that mean the user had to teach the lesson again. Counts alone cannot establish relevance; recall audits supply that context.

## Entry template

- ID:
- Date:
- Decision:
- Why:
- Hypothesis:
- Metric(s) and how to read them with `pi-memory stats`:
- Baseline:
- Review on:
- Outcome (filled at review):

## D-001

- ID: D-001
- Date: 2026-10-29
- Decision: Record the baseline before changing measurement or extraction validation.
- Why: Capped ledgers were the only surviving source of usage and votes.
- Hypothesis: Memory earns its prompt and writer cost when it is used in later relevant sessions, not merely reminded or written.
- Metric(s) and how to read them with `pi-memory stats`: Compare loaded and applied counts with reminded and confirmed counts, using `pi-memory stats --since 2026-10-09`. This command cannot reconstruct events already lost before history existed or identify relevant sessions on its own.
- Baseline: Three weeks since 2026-10-09, measured from capped ledgers: 25 topics; 9 loaded at least once; 12 topic loads total; 12 topics reminded at least 19 times with 0–1 loads; repo topics approximately 250 reminders versus 7 loads; 1 vote on topic memories total. `user.md` held 18 memories with 57 applied, 11 confirmed, 5 ignored, and 1 contradicted. Writer runs: 104 total, 71 ok, 14 nothing, 2 skipped, 17 failed. Failures: 3 expired SSO token, 8 apply-model “No models match”, 4 pass-1 validation rejects that lost the whole run, 1 invalid JSON, and 1 other. These supplied baseline figures include apply-model failures; current stats deliberately separates writer runs from proposal apply runs.
- Review on: 2026-11-19
- Outcome (filled at review): Pending.

## D-002

- ID: D-002
- Date: 2026-10-29
- Decision: Keep full usage, vote, and extraction history and add read-only stats in pi and the CLI.
- Why: Usage folding deleted its source log and capped ledgers discarded older events and removed memories.
- Hypothesis: Durable events let later decisions compare actual use across time windows without the ledger cap distorting trends.
- Metric(s) and how to read them with `pi-memory stats`: Run `pi-memory stats --since 2026-10-29` for known sessions, per-topic reminders, loads and votes, user votes, writer outcomes, and candidate-drop reasons. Confirm that history retains events beyond 20 while ledgers remain capped.
- Baseline: D-001; no durable usage, vote, or extraction history.
- Review on: 2026-11-19
- Outcome (filled at review): Pending.

## D-003

- ID: D-003
- Date: 2026-10-29
- Decision: Drop invalid pass-1 candidates and votes individually, preserving valid siblings.
- Why: An empty or overlong evidence quote discarded every candidate and vote in the run.
- Hypothesis: Item-level validation preserves useful lessons without relaxing the validity rules for an accepted lesson.
- Metric(s) and how to read them with `pi-memory stats`: In `pi-memory stats --since 2026-10-29`, item-caused pass-1 validation failures should reach zero; inspect candidates dropped by reason to see what still needs prompt work. Structurally unusable answers can still fail the pass.
- Baseline: 4 whole-run pass-1 validation rejects in the 104-run baseline.
- Review on: 2026-11-19
- Outcome (filled at review): Pending.

## D-004 — Writer runs on the smart tier

- ID: D-004
- Date: 2026-10-29
- Decision: `writerModel` moves from `tier/fast` to `tier/smart` (decided 2026-10-29, set in dotfiles `pi/.pi/agent/settings.base.json`). The owner is also re-pointing the Bedrock smart tier above Opus, because Opus performs at the level of Codex mid (Sol) and Astra corresponds to a stronger Anthropic model.
- Evidence (offline replay, 20 sessions, live codex profile, blinded Bedrock Opus judge): fast `openai-codex/gpt-6-luna` passed validation 18/20 (both failures were evidence quotes over 20 words), produced 1.30 candidates per session, judge mean 3.94, 42.3% of candidates scored at least 4. Smart `openai-codex/gpt-6.1-sol` passed 20/20, produced 1.80 candidates per session, judge mean 4.21, 88.9% scored at least 4. Mean latency 11.7 s against 13.2 s; token cost was not observable. Mid `gpt-6.1-terra` is rejected on the ChatGPT account, so `tier/mid` cannot run at all under the codex profile. Caveats: one judge, historical memory snapshots reconstructed from dotfiles git with a timing heuristic.
- Evidence v2 (`evals/2026-10-29-v2-all-tiers/`, six writers, blind judges Opus and Astra): mean score averaged over both judges and share of candidates at 4 or more were Luna 4.39 / 88%, Sol 4.61 / 97%, Astra 4.60 / 100%, Haiku 4.17 / 66%, Sonnet 4.25 / 73%, Opus 4.57 / 95%. Under the Opus judge alone, Opus 4.47, Sol 4.32, Astra 4.29, Haiku 4.06, Luna 4.02. Valid runs out of 20: Luna 18, Sol 20, Astra 19, Haiku 20, Sonnet 13, Opus 16; every failure was an evidence quote over 20 words, which D-003 now drops per candidate instead of losing the run. The judges agree only moderately (r 0.55, weighted kappa 0.37) and Astra scores Codex output higher, so counts of uncaptured lessons (7 against 77) are not reliable. Smart tiers beat fast tiers on both providers; tier is not monotonic on Bedrock, where Sonnet trails Haiku in the Opus judge's share at 4 or more.
- Why: Evaluate cost and extraction quality before changing the writer model.
- Hypothesis: A smart-tier writer keeps more lessons that are worth keeping, so more topic memories exist to be applied later.
- Learnings: Model choice drives lesson quality and tier names are not comparable across providers; compare models, not tier labels. A judge from one family can favour its own family, so use two judges from different families and trust rankings that both agree on. Under the Opus judge alone Haiku and Luna score about the same, so the apparent weakness of the Anthropic fast tier comes partly from the Codex judge.
- Metric(s) and how to read them with `pi-memory stats`: Offline replay of 20 sessions across fast/mid/smart; results in `~/.local/state/pi-skill-memory/evals/2026-10-29-model-tiers/`. Use stats writer outcomes and candidate-drop reasons as production context; stats does not score replay quality or costs by model.
- Baseline: D-001 plus the offline replay results when available.
- Review on: 2026-11-19
- Outcome (filled at review): pending

## D-005 — PENDING

- ID: D-005
- Date: 2026-10-29
- Decision: Pending; the audit is done and recall is the bottleneck, so the next change targets recall before capture.
- Evidence (same 20 sessions, judged): 29 topic loads should have happened, 3 did, 0 loads were irrelevant. Recall is about 10% with perfect precision. Of the 26 misses, the judge attributed 15 to a description whose wording does not match the moment it applies, 11 to an agent skipping a topic whose description did match, and none to the need arising mid-task or the topic being buried. Reminders reach top-level sessions about as often as child sessions (37 against 35 deliveries), and many arrive inside tool results rather than as reminder messages; ledger `reminded` counts are per topic mentioned, so they overstate reminder messages.
- Evidence v2 (findability simulation, 29 positive and 10 negative moments, 351 selector trials): asked explicitly which skills it would read, Opus picked the right topic in 23 of 29 moments with the current descriptions (79%), and Astra in 25 (86%). Rewritten descriptions moved recall by at most one hit, for better or worse, depending on the rewriting model. Real sessions loaded 3 of the same 29. Description wording is therefore not the main cause of misses, despite the first audit's attribution: the agent can recognise the topic when asked, but during real work it rarely stops to select skills. Precision is the weaker side, with 15 to 21 wrong topic picks per set.
- Why: Determine whether topic skills load when relevant, rather than optimizing reminder counts alone.
- Hypothesis: Missed relevant loads explain some repeated teaching.
- Metric(s) and how to read them with `pi-memory stats`: Compare reminded and loaded columns and topics never loaded with relevance judgments in the recall audit in `~/.local/state/pi-skill-memory/evals/2026-10-29-model-tiers/`. Stats counts events, not relevance.
- Baseline: D-001, especially 12 topics with at least 19 reminders and 0–1 loads.
- Review on: 2026-11-19
- Outcome (filled at review): pending

## D-006 — Select relevant topics at turn start

- ID: D-006
- Date: 2026-10-29
- Decision: Start a nonblocking topic selector at each user turn and deliver ready selections through the per-model-call context hook, using rule injection by default and optional file pointers. Keep repo-wide reminders enabled by default but independently configurable.
- Why: Real sessions loaded only 3 of 29 relevant topics, while explicit selection with current descriptions found 23–25 of 29. The agent recognises relevance when asked but does not reliably stop to select skills during work.
- Hypothesis: Topic usage (loaded plus rule-injected per relevant session) and applied votes on topic memories rise well above D-001 without more contradicted votes.
- Metric(s) and how to read them with `pi-memory stats`: Run `pi-memory stats --since 2026-10-29` for selected, injected, loaded, applied and contradicted columns and the selected topic/session pairs later applied ratio. The ratio requires a vote at or after selection in the same session and includes undelivered selections in its denominator. History retains delivery mode; point-mode injections are pointers, not rule loads. Relevance still requires a separate recall audit, and stats cannot attribute causality or model cost.
- Baseline: D-001 recorded 12 loads, 9 of 25 topics ever loaded and 1 topic-memory vote in three weeks. The 20-session audit found 3/29 relevant loads (10.3% recall); explicit selection found 23/29 with Opus and 25/29 with Astra (79–86% recall, 63%/57% precision). No selector or injection events existed before this change.
- Review on: 2026-11-19
- Outcome (filled at review): Pending. Short turns may end before delivery; false positives and truncated rules require review alongside applied and contradicted votes.

## D-007 — Keep current descriptions

- ID: D-007
- Date: 2026-10-29
- Decision: Do not rewrite topic descriptions as a recall intervention now; keep the existing writer description behaviour unchanged.
- Why: The v2 simulation showed no consistent recall gain from rewrites. Current descriptions already selected 23/29 relevant topics with Opus and 25/29 with Astra; the best in-sample rewrite gained only one hit with each selector, while other rewrites lost hits.
- Hypothesis: Explicit selection improves real usage more than a description rewrite, so leaving descriptions alone avoids an unsupported intervention while D-006 is evaluated.
- Metric(s) and how to read them with `pi-memory stats`: Track loaded, injected, applied and contradicted counts with `pi-memory stats --since 2026-10-29` during D-006. Stats cannot measure description quality or recall directly; compare any future wording proposal with a fresh blinded relevance audit before changing this decision.
- Baseline: V2 used 29 positive and 10 negative moments. Opus current descriptions: 79% recall, 63% precision; rewrites: 69–83% recall, 58–67% precision. Astra current descriptions: 86% recall, 57% precision; the best in-sample set: 90% recall, 62% precision. Single draws, imperfect oracle labels and in-sample selection do not establish a wording benefit.
- Review on: 2026-11-19
- Outcome (filled at review): Pending.

## Data we keep and why

| File | Decisions supported |
| --- | --- |
| Memory directory `user.md`, `memory-skills/<topic>/SKILL.md` | D-001, D-004, D-005, D-006, D-007: the actual memories, descriptions, and scope whose utility we judge. |
| Memory directory `user.ledger.json`, `memory-skills/<topic>/ledger.json` | D-001, D-002: capped baseline fallback and live weights/eviction, not full measurement history. |
| Memory directory `proposals.md` | D-004: lessons routed to hand-written skills rather than automatic memory writes. |
| State `usage.jsonl`, `usage.<pid>.folding.jsonl` | D-002, D-005, D-006: pending usage, including folds interrupted before removal; stats reads these without claiming or folding them. |
| State `history/usage-YYYY-MM.jsonl` | D-002, D-005, D-006: append-only reminded/loaded/selected/injected events with session, timestamp and selector delivery mode, retained even when a topic disappears. |
| State `history/votes-YYYY-MM.jsonl` | D-002, D-003, D-004: every applied writer vote with topic, memory id, kind, session, and timestamp, including retractions. |
| State `history/extractions-YYYY-MM.jsonl` | D-002, D-003, D-004: each attempted pass-1 result, configured model (or pi default), kept candidates, dropped candidates/votes with raw item and reason, accepted votes, and structural/model errors. |
| State `runs.jsonl` | D-001, D-003, D-004: writer outcomes and failures; proposal apply records remain separate from writer counts. |
| State `writer.log` | D-003, D-004, D-006: operational failure context, including silent selector failures and timeouts, such as authentication or model selection errors. |
| State `jobs/*.json` | D-004: queued/retryable inputs for operational diagnosis, not a permanent outcome history. |
| State `proposals-state.json` | D-004: approval, retry, and failure context for lessons sent to hand-written skills. |
| State `evals/2026-10-29-model-tiers/` | D-004, D-005: offline model replays and recall audit artifacts, read separately from production stats. |
| State `evals/2026-10-29-v2-all-tiers/` | D-004, D-005, D-006, D-007: read-only model and description-selection evidence; not production stats. |
| Memory directory `.writer.lock` | D-002: transient serialization of writer mutations, not measurement data. |

History contains lesson text and evidence quotes, so it is sensitive like the source transcripts. No automatic retention or pruning is applied; deleting history reduces future measurement fidelity. Existing lost events cannot be recovered, and legacy session counts are unknown.

## Planned next — not decided

- Before-compaction flush.
- Episodic `## Examples` in topics.
- Audit D-006 selected-to-applied conversion and relevant-session usage before revisiting D-007 descriptions; investigate short-turn misses and false-positive selections.
