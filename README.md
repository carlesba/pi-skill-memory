# pi-skill-memory

pi-skill-memory gives the pi coding agent a long-term memory that it writes itself. Before compaction, after a session ends, or when startup recovers an interrupted session, a background writer reads the unprocessed transcript, keeps the lessons the user taught the agent, and files them where the next session will find them. A background selector asks which topics apply at the start of each user turn without making the turn wait; selection adds model cost, but never waits on the read path.

## Why memory is written as skills

pi already has a mechanism for knowledge that should be loaded only when it applies: skills. Each skill is listed by name and description, and the agent reads the body when the description matches the work in front of it. pi-skill-memory stores each memory topic as an ordinary skill, so a topic about state management in one repository costs a single line in the prompt until the agent decides it needs it. A topic describes one trigger moment, such as "when changing state management in preply/apollo" or "when writing React components in any repo", rather than a broad subject, which keeps the descriptions precise enough for the agent to choose well.

Memory that holds everywhere, such as how you like pull requests split or how terse you want answers, goes into a single `user.md` file that is always in the prompt. Its memories carry ids, votes and weights exactly like those in topics.

## Storage

Everything lives in the memory directory (the `dir` setting).

- `user.md` holds memory about how you work in any repository. Like a topic body, it is one short paragraph per memory, each ending in a block id such as `^r3`.
- `user.ledger.json` is the ledger for `user.md`, with the same entry for each memory as a topic ledger. It is never shown to the model.
- `memory-skills/<topic>/SKILL.md` is one topic skill. Its frontmatter carries `name`, `description`, `metadata.scope` (`generic` or `repo:<owner>/<name>`) and `metadata.updated`. The body is one short paragraph per memory, each ending in a block id such as `^r7`. Topic names look like `mem-apollo-state` for a repository topic and `mem-any-react-components` for a generic one, and the directory is named after the skill.
- `memory-skills/<topic>/ledger.json` records where each memory came from, its origin and the votes it has received. It is never shown to the model.
- `proposals.md` collects lessons that belong in one of your hand-written skills. The writer never edits those skills on its own; it proposes the change, and a skill changes only after you approve the proposal in `/proposals`.

The state directory (the `stateDir` setting) sits outside the memory directory because its files change constantly. It holds `usage.jsonl` (which topics were reminded, loaded, selected and injected), `runs.jsonl` (one line per writer run or proposal apply and its outcome), `proposals-state.json` (the comments, snoozes and last apply errors of pending proposals), `writer.log`, and the queued writer jobs. It also keeps append-only monthly files under `history/`: `usage-YYYY-MM.jsonl` preserves folded reminded/loaded/selected/injected events, `votes-YYYY-MM.jsonl` preserves every vote the writer applies (including retractions), and `extractions-YYYY-MM.jsonl` records each attempted pass-1 result with session, timestamp, configured model (or `pi default`), kept candidates, dropped items and reasons, accepted votes, and any pass-1 error. History is not capped or pruned automatically and can include evidence quotes, so treat it as sensitive session data. Existing events already lost to ledger caps cannot be recovered.

A repository is identified by its normalized git remote, so `git@github.com:preply/apollo.git`, `https://github.com/preply/apollo` and `ssh://git@github.com/preply/apollo` are all `preply/apollo`. Worktrees and separate clones of the same repository therefore share their memory, and the directory name of a checkout never matters.

## Read path

When a session starts, the extension tells pi to list the generic topics and the topics scoped to the repository that contains the working directory. They appear in the skills list exactly like hand-written skills.

Sessions often reach into other repositories. Every time a tool call touches a path (the `path` argument of `read`, `edit`, `write`, `grep`, `find` and `ls`, and absolute paths, `cd` targets and `git -C` targets in `bash`), the extension resolves the path to its git repository. The first time a session touches a repository that has memory topics, it appends one line to that tool result naming the topics and where to read them, for example `[memory] preply/apollo has memory skills: mem-apollo-abstractions, mem-apollo-state — load the ones that apply`. Each repository is announced once per session, and the announced set is cleared after compaction because the earlier reminder may have been summarized away. When your prompt names a repository that has topics, either as `owner/name` or as a bare name of at least four characters, the same reminder is added to that turn as a hidden message.

At `before_agent_start`, the selector starts an in-process completion through pi's model registry using `selectorModel` (default `tier/fast`). It sees the user message, the last 2000 characters of the previous assistant text, and candidate names and descriptions: generic topics plus topics for the working repository and repositories touched or named in this session. It validates a JSON list of at most three candidate names. No model request waits for selection. The per-LLM-call `context` hook delivers a ready result to the next request in that agent run; results still pending at run end, compaction, session replacement or shutdown are dropped. A short single-call turn can therefore miss its selection entirely. Missing models, timeouts and other failures are silent in the UI and recorded in `writer.log`; configure an available provider/model if `tier/fast` is not registered.

The default `selector.mode`, `inject`, supplies SKILL.md body text with a heading explaining the match, bounded to `selector.maxChars` characters per selection including headings (default 3000). A body may be truncated to fit. Mode `point` names the files and asks the agent to read them instead. Delivered context is ephemeral, not written into the transcript or system prompt, and is retained for subsequent model calls until compaction. Topics already loaded or injected are not selected again until compaction; point reminders are likewise deduplicated. Set `selector.enabled` to false to disable selection, or `reminders` to false to disable only the older repo-wide reminders. Both are enabled by default.

`user.md` is read once when the session starts and added to the system prompt as its own section on every turn, block ids included. Because the text is frozen for the session, the prompt prefix stays byte-identical from turn to turn and prompt caching keeps working, and the section survives compaction. Edits to `user.md` take effect in the next session.

The extension records a `reminded` event for each topic named in a reminder and a `loaded` event when the agent reads a topic's `SKILL.md`. These events feed the weights described below. Selection additionally records `selected` and delivery records `injected`, each with topic, session, timestamp and mode; `injected` in point mode means a pointer was delivered, not that rules were loaded. These two event kinds measure recall without changing live weights. Rule injections count as loaded topics for the writer’s votes, including when another writer has already folded their usage into history. The writer claims `usage.jsonl` as `usage.<pid>.folding.jsonl`, appends its events to monthly usage history before updating ledgers, and removes the claimed file only after folding succeeds. Interrupted folds retain their source; retrying an archive does not duplicate its events.

## Write path

When a session ends or is about to compact, the extension queues a writer for that session’s unprocessed turns. Set `flushBeforeCompaction` to false to disable the compaction hook. It skips sessions with fewer than `minUserMessages` messages a human typed, and it skips processes where any environment variable in `skipWriteWhenEnv` is set. That list is empty by default, because the package does not know which other tools run pi on your behalf; add their variables when you want to switch the writer off for them. Reading memory still works in skipped processes. Reloading the extension does not queue a writer, because the session continues.

Each job pins the active branch endpoint at enqueue time, so later messages or branch switches cannot change its input. A `pi-skill-memory-watermark` custom session entry records that queued endpoint and the previously completed endpoints. Queueing alone does not mark turns processed: successful (`ok` or `nothing`) run records certify completion under the writer lock. Later jobs read only turns after the furthest completed endpoint on their branch, plus the preceding assistant text explicitly labelled as context, not evidence. They still see the whole branch’s topic reads and the whole session’s loaded/injected usage for votes. The writer drops a vote already recorded with the same memory, kind and session, recording that rejection in extraction history. Failed pass-1 jobs leave their turns available; existing pass-2 rejection behaviour is unchanged.

On terminal-UI startup only, an asynchronous scan looks for sessions modified in the last `recoverDays` days (default 3) under `<agentDir>/sessions`, directly or one project directory below it. It never descends into `run-*` child directories, and skips the current session, sessions with any writer run in `runs.jsonl` (including failures), and queued sessions. At most `recoverMaxSessions` jobs (default 3), newest first, are queued for sessions meeting the human-message threshold. Either recovery setting at zero disables recovery. Startup does not await the scan, and `skipWriteWhenEnv` applies. Sessions with earlier writer records but a later interrupted tail are not recovered automatically; resume them and use `/memory write`. Recovery is bounded capture, not a guarantee against process death during a memory write.

Runs and extraction history include `shutdown`, `compaction`, `recovery` or `manual` triggers. Stats groups runs and lessons kept by trigger, where “kept” means pass-1 accepted candidates, not successful pass-2 writes. Legacy records without a trigger appear as `unknown`. Stats also counts repeated confirmed votes on the same memory in one session.

### Learning only from what a human typed

A session's user-role messages are not all written by you. A scheduler, a script or a parent agent that starts pi writes its brief as a user message too, and a lesson taken from such a brief would record a program's instructions as your preferences. The package therefore learns only from messages a human typed, and it decides that from where pi says each message came from rather than from who launched the process, which it cannot know.

pi reports every prompt with a source: `interactive` for the editor, `rpc` for a client of RPC mode, and `extension` for a message an extension sent. The extension records the source and the run mode of each user message as a custom entry in the session file, which keeps the record with the transcript across `/resume` and forks and lets the writer read it after pi has exited. A message counts as human when its source is listed in `learnFromSources`, which is `["interactive"]` by default. pi also labels prompts given to `pi -p` and `pi --mode json` as `interactive`, so an `interactive` message counts only when pi runs its terminal UI. As a result an autonomous run in print or JSON mode never qualifies, whoever launched it. Add `rpc` to `learnFromSources` when a person types into an RPC client such as an editor integration.

`minUserMessages` counts only human messages, so a session with none is never written. The writer still shows the model the other user-role messages, labelled as instructions from another program, so it understands the task, and the extract prompt forbids taking a lesson, a vote or an evidence quote from them. Sessions recorded before this version carry no source entries and are treated as having no human messages.

The writer takes a lock on `.writer.lock` in the memory directory, so writers from several sessions run one after another. The writer holding the lock refreshes its timestamp every minute; another writer takes the lock over only when the holder's process is gone or the timestamp has not been refreshed for 5 minutes, so a long run is never interrupted. It then runs two passes through `pi -p` with extensions, tools, skills and context files turned off, using `writerModel` when it is set and pi's default model otherwise. Only the extensions listed in `writerExtensions` load in those runs.

The first pass reads a bounded digest of the session: every user message, labelled as yours or as instructions from another program, the final assistant text before each of your messages, the repositories the session touched, the index of memory topics and hand-written skills, `user.md`, and the full text of the topics loaded or rule-injected in that session. It returns candidate lessons with their evidence and a target (`user.md`, an existing topic, a new topic, or a proposal for a hand-written skill), plus votes on the memories it was shown: every memory in `user.md`, which is in every session, and the memories of the topics loaded or rule-injected in that session. A lesson that repeats an existing memory, in a topic or in `user.md`, becomes a `confirmed` vote rather than a candidate. A lesson counts only when it came from you, through a statement, a correction or a choice, and when it will still be true next month.

Pass 1 validates candidates and votes independently: an invalid item is dropped with its reason in the run’s rejected list and extraction history, while valid siblings continue. Candidates beyond the 20-candidate limit are dropped individually. Only an unusable top-level structure or an answer that cannot be parsed as JSON fails validation for the whole pass; model invocation errors also fail the pass.

The second pass rewrites each touched topic, and `user.md` when a lesson targets it, as a whole file. It sees each memory's origin, weight and age. It merges restatements, resolves conflicts by keeping one memory (a human memory beats an observed one whatever their age or weight, and between two of the same origin an explicit statement beats an inference, newer evidence beats older, and higher weight beats lower), and reports what it replaced and why. The extension validates every answer before applying it: the JSON shape, size limits, frontmatter, that every memory id exists, that every existing memory missing from the answer is listed with a reason in what it replaced, and that every write stays inside the memory directory. A rejected answer leaves the topic or `user.md` untouched and is recorded in `runs.jsonl`.

### Runners

The default runner, `detached`, starts the writer as a detached background Node process that outlives pi. It needs nothing else installed.

The `pueue` runner adds the writer to a [pueue](https://github.com/Nukesor/pueue) group (`pueueGroup`, created if missing and limited to one task at a time). Pueue gives you a queue you can inspect with `pueue status`, showing which writers are waiting, running, done or failed. The writer's output still goes to `writer.log` in the state directory. A failed run keeps its job file in the state directory, so `pueue restart <id>` retries it; a successful run deletes its job file. Without pueue you lose the queue view and that retry: the detached runner runs the same writer and the lock serializes it the same way, but a failed detached run is only recorded in `runs.jsonl` and `writer.log`, and its job file stays in the `jobs` directory until you delete it. If `pueue` is selected but not on `PATH`, or the pueue daemon does not answer, the writer falls back to the detached runner and notes it in `writer.log`.

## Ledger, weights and eviction

The extension, not the model, owns the ledgers: one `ledger.json` per topic and `user.ledger.json` for `user.md`. The model marks each memory with an existing id or as new, an answer that names an id the ledger does not know is rejected, and the extension mints ids for new memories from a counter that only increases, so an id is never reused. After every write it deletes ledger entries whose id is no longer in the topic or in `user.md`.

A paragraph you add to `user.md` by hand without an id, or a `user.md` that has no ledger yet, does not stop the writer: on its next run it gives each unmarked paragraph the next free id and writes the ids back to `user.md`. A memory adopted this way has no learned date, so it is not protected from eviction. An id you add by hand that the ledger does not know, in `user.md` or in a topic, keeps its number and gets a ledger entry with no learned date, and the counter moves past it.

Each memory in the ledger has an `origin`. A `human` memory came from something you said, and every memory the writer creates today is `human`; ledgers written before the field existed read as `human` too. An `observed` memory would be a fact the agent saw in the work rather than something you stated. The writer does not learn observed facts yet: the value is reserved for a later version, and the merge prompt already ranks a human memory above an observed one.

Votes come from the first pass and from usage. `applied` means a memory bore on the work and you did not correct it, `confirmed` means a new lesson repeated it, `ignored` means the agent did not follow it and you corrected the agent toward it, `contradicted` means the agent followed it and you corrected the agent away from it, and `retracted` means you withdrew it, which deletes it at once. A memory's weight is the sum of its votes (applied, confirmed and ignored count +1, contradicted counts −2), each halved every `halfLifeDays`. A topic's weight adds its decayed `loaded` events to its memories' weights. Each ledger keeps the last 20 votes per memory, and for the topic the last 20 `loaded` and the last 20 `reminded` events separately, so frequent reminders never push out the record of a topic being loaded. These caps affect live weights only; full events remain in state history. `reminded` events carry no weight and do not count as loads. An `ignored` vote on a topic memory also tells the writer to reword the topic's description so it gets loaded at the right moment.

Weights only order eviction; nothing is deleted while it is under a cap. When a topic holds more than `maxMemoriesPerTopic` memories, the lowest-weight ones are evicted, except memories younger than `protectNewDays`. When the rewritten `user.md` is longer than `maxUserChars`, memories are evicted the same way, lowest weight first and never one younger than `protectNewDays`, until it fits; if it still does not fit once only protected memories are left, the answer is rejected and `user.md` stays as it was. When a scope already has `maxGenericTopics` or `maxTopicsPerRepo` topics, a lesson that would open a new topic goes to the closest existing topic instead. A topic that has not been loaded in `staleTopicDays` is merged into a similar topic in the same scope, or removed when there is none.

## Settings

Settings live under the `memory` key in pi's `settings.json`, either `~/.pi/agent/settings.json` or a project's `.pi/settings.json`. Every key is optional.

| Setting | Default | Meaning |
| --- | --- | --- |
| `dir` | `<agentDir>/memory`, usually `~/.pi/agent/memory` | The memory directory. `~` expands, and a relative path resolves against the agent directory. |
| `stateDir` | `${XDG_STATE_HOME:-~/.local/state}/pi-skill-memory` | Usage, run and writer logs, append-only history, and queued jobs. |
| `selector.enabled` | `true` | Start background topic selection for each user turn. |
| `selectorModel` | `tier/fast` | Registered pi model (`provider/model`) used for in-process selection. |
| `selector.mode` | `inject` | `inject` supplies bounded rule text; `point` only asks the agent to read selected files. |
| `selector.timeoutMs` | `5000` | Deadline for background selection; timeout cancels and logs silently. |
| `selector.maxChars` | `3000` | Total characters of rule text and headings per selection in inject mode. |
| `reminders` | `true` | Keep the repo-wide prompt/tool-result reminders independently of selection. |
| `writerModel` | unset (pi's default model) | The model the writer passes to `pi -p --model`. |
| `writerExtensions` | `[]` | Extensions the writer loads with `-e` while every other extension stays off. List the extension that provides `writerModel` when it is a virtual model or comes from a provider extension. `~` expands, and a relative path resolves against the agent directory. |
| `runner` | `detached` | `detached` or `pueue`. |
| `pueueGroup` | `pi-skill-memory` | The pueue group the writer uses. |
| `minUserMessages` | `3` | Unprocessed segments with fewer messages a human typed are not written automatically. |
| `flushBeforeCompaction` | `true` | Queue qualifying unprocessed turns before compaction. |
| `recoverDays` | `3` | Recover interrupted top-level sessions modified within this many days on terminal-UI startup; zero disables recovery. |
| `recoverMaxSessions` | `3` | Maximum recovery jobs per startup; zero disables recovery. |
| `maxCharsPerTopic` | `4000` | Maximum size of a topic body. |
| `maxMemoriesPerTopic` | `12` | Memories per topic before eviction. |
| `maxGenericTopics` | `10` | Generic topics before new lessons are routed to existing ones. |
| `maxTopicsPerRepo` | `8` | Topics per repository before new lessons are routed to existing ones. |
| `maxUserChars` | `4000` | Size of `user.md` before eviction. |
| `halfLifeDays` | `90` | Days for a vote's weight to halve. |
| `protectNewDays` | `30` | Memories younger than this are never evicted. |
| `staleTopicDays` | `60` | A topic not loaded for this long is merged or removed. |
| `autoCommit` | `true` | Commit each write when the memory directory is in a git repository. |
| `skipWriteWhenEnv` | `[]` | Environment variables that turn the writer off for a process when any of them is set. |
| `learnFromSources` | `["interactive"]` | The pi input sources (`interactive`, `rpc`, `extension`) whose messages count as typed by a human. `interactive` counts only in the terminal UI. |

A settings file that keeps memory in a dotfiles repository and uses pueue looks like this:

```json
{
  "memory": {
    "dir": "~/dotfiles/pi-memory",
    "runner": "pueue",
    "writerModel": "anthropic/claude-sonnet-4-5"
  }
}
```

## Keeping memory in a git repository

Point `dir` at a directory inside a git repository to get a history of everything the writer learned and forgot. With `autoCommit` on, each writer run commits its changes, with a message that lists the topics it touched and, for every memory it replaced or evicted, the reason. The commit stages only `user.md`, `user.ledger.json`, `memory-skills` and `proposals.md`, and it leaves anything else you have staged alone. The writer commits with your git configuration, so a signing setup that prompts for a passphrase will stall it.

The lock file `.writer.lock` is never committed, but it does appear as an untracked file while a writer runs. Add it to the repository's `.gitignore`:

```gitignore
.writer.lock
```

## Installing

Install the published package with `pi install npm:pi-skill-memory`.

Before it is published, install it from a local checkout by its absolute path, for example `pi install /Users/you/code/pi-skill-memory`. pi records the path in `~/.pi/agent/settings.json` and loads the extension from the checkout without copying it. pi does not run `npm install` for local packages, so the checkout's `node_modules` is yours to manage. The extension imports only pi's own packages, which pi provides at runtime, so it loads without one; run `npm install` in the checkout yourself when you want to run the tests or the typecheck. To try the extension for one session without saving it, run `pi -e /Users/you/code/pi-skill-memory`.

pi loads the extension's TypeScript directly. The writer runs as a separate Node process, which needs Node 22.18 or newer. Node refuses to strip types from files under `node_modules`, so the published package also ships the writer compiled to `dist/`, built by `npm pack` and `npm publish`. The writer runs `dist/writer/main.js` when it exists and `src/writer/main.ts` otherwise. In a local checkout where you have run `npm run build`, delete `dist/` or rebuild it after editing the writer, or the writer will keep running the old build.

## Commands

- `/memory status` shows the memory and state directories, whether `user.md` exists, how many topics each scope has, the last writer run with its outcome, the last proposal apply, and the runner, including whether `pueue` is on `PATH`. `/memory` on its own does the same.
- `/memory stats [--since YYYY-MM-DD]` (or `pi-memory stats [--since YYYY-MM-DD]`) reports known sessions, per-topic reminders, loads, selections, injections and vote counts, topics never loaded in the window, `user.md` votes, writer outcomes, runs and pass-1 accepted lessons by trigger, repeated same-session confirmations, pass-1 validation failures, and candidate-drop reasons in aligned text tables. It also reports selected topic/session pairs with a later applied vote in the same session; the denominator includes selections that were never delivered. Injection counts include both modes, whose distinction is retained in usage history. The date is an inclusive UTC lower bound. This command is read-only: it reads history and pending usage (including interrupted folds) without folding or writing state, and supplements events absent from history with capped ledger data, explicitly flagged as incomplete. Older ledger-only events have no session ids, so the session count is a lower bound. Topics removed since a historical event remain visible through history; “never loaded” means no retained load in the selected window, not proof of irrelevance. Writer counts exclude proposal apply jobs. See `docs/decisions.md` for baselines, hypotheses, and review dates.
- `/memory explain` shows which topics pi currently lists and why (pi refreshes that listing at startup and on `/reload`, not on `/new` or `/resume`, so it can still reflect the directory pi started in), and which topics were named in reminders and what triggered each one: the tool call and path, or the word in your prompt.
- `/memory write` queues the writer for the current session’s unprocessed turns now, even when the session has fewer than `minUserMessages` human messages or a variable in `skipWriteWhenEnv` is set. Quitting afterwards does not queue the same session again unless you have continued it.
- `/proposals` opens the proposal review app over pi, as described below. The same app runs outside pi as `pi-memory review`.

## Reviewing proposals

When pi starts in the terminal UI and proposals are waiting, a line above the editor says how many, for example `3 memory proposals — /proposals`. It never opens a dialog by itself, it clears as soon as you type, and it does not appear for `/new`, `/resume`, forks, or modes without the terminal UI. The same line reports the result of the last apply job once, for example `last apply: applied 2 to react-code · 1 skipped`.

The review is a full-screen app built on [fzf](https://github.com/junegunn/fzf), which must be on `PATH`. `/proposals` suspends pi while it runs and returns to the chat when you quit; `pi-memory` (or `pi-memory review`) opens it from any shell. It shows one proposal at a time, the pending ones in order or the omitted ones when none are pending, and moves to the next after each decision. The border names its position and skill, for example `memory proposal 2 of 6 · react-code`. The actions take exactly the rows they need at the bottom, and the rest of the screen previews the proposal: the rule, why, the quoted evidence, any comment, the last apply error, and the section of the target skill's `SKILL.md` that shares the most words with the rule, with its `path:line`. The preview is coloured by `bat` when it is installed, with its `ansi` theme so it uses your terminal's own palette (set `BAT_THEME` to pick another), and fzf uses the same 16 colours. It scrolls with `j`/`k` (three lines), `ctrl-d`/`ctrl-u` (half a page), Space or the mouse wheel. Below it, the actions take one key, or the arrow keys and Enter, and the header confirms the last one:

- `a` Apply queues the proposal, with its comment, for a background apply job.
- `c` Comment opens `$VISUAL` or `$EDITOR` on an instruction for the apply job, such as "only the first sentence" or "put it under Providers", then shows the same proposal again. The comment is kept if you omit the proposal.
- `d` Discard deletes the entry from `proposals.md` and commits that file in the memory directory. It waits for a running writer, because the writer appends to the same file.
- `o` Omit hides the proposal for 24 hours; then it counts as pending again.
- `s` Skip leaves the proposal as it is and shows the next one.
- `q` or Esc quits.

The app is a thin layer over subcommands you can also script: `pi-memory list`, `show <id>`, `apply <id>`, `comment <id>`, `discard <id>` and `omit <id>`. An RPC client reviews through a select dialog per proposal and an editor dialog for comments. Without any UI, `/proposals` lists the pending proposals.

Each approved proposal goes into a background job on the writer's queue, so no skill is edited in your chat. The job finds each skill through the skill index and follows its symlink to the real file. It skips a skill, keeping its proposals pending, when that `SKILL.md` has uncommitted changes or its repository is not on `main` or `master`, so a model edit is never mixed with your work in progress. Otherwise it asks the writer model to work each rule into the place in the skill where it belongs and to honour your comments, checks that the answer keeps the frontmatter and the `name`, is not empty and did not grow beyond the rules it adds, and writes the file atomically. Each skill gets one local commit, `<skill>: apply memory proposal(s)`, that stages only that file and lists each rule with its comment. The job never pushes: `git log` is the review, `git revert` is the undo, and pushing stays with you. Applied entries are then removed from `proposals.md` and that change is committed in the memory directory. Apply jobs take the writer's lock, so two jobs never edit the same skill at once.

Approving a proposal is remembered, so it does not come back for review as if you had never decided. When its apply job fails for a reason the job can recover from, such as a model answer that does not validate or a job that died, the next terminal-UI start retries it in the background, up to three attempts. When the failure needs you, because the skill has uncommitted changes or is off `main`, the skill is missing, the commit failed or the writer model has no credentials, or once the attempts run out, the proposal comes back to `/proposals` marked as a failed apply. Its card leads with the reason; Apply retries it after you fix the cause and Discard drops it. The startup line counts these, for example `3 memory proposals (1 failed to apply and needs you) — /proposals`. `/memory status` reports the last apply run.

## License

MIT
