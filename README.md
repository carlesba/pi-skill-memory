# pi-skill-memory

pi-skill-memory gives the pi coding agent a long-term memory that it writes itself. After a session ends, a background writer reads the transcript, keeps the lessons the user taught the agent, and files them where the next session will find them. Nothing on the read path calls a model, so memory adds no latency and no cost to your sessions.

## Why memory is written as skills

pi already has a mechanism for knowledge that should be loaded only when it applies: skills. Each skill is listed by name and description, and the agent reads the body when the description matches the work in front of it. pi-skill-memory stores each memory topic as an ordinary skill, so a topic about state management in one repository costs a single line in the prompt until the agent decides it needs it. A topic describes one trigger moment, such as "when changing state management in preply/apollo" or "when writing React components in any repo", rather than a broad subject, which keeps the descriptions precise enough for the agent to choose well.

Memory that holds everywhere, such as how you like pull requests split or how terse you want answers, goes into a single `user.md` file that is always in the prompt.

## Storage

Everything lives in the memory directory (the `dir` setting).

- `user.md` holds memory about how you work in any repository.
- `memory-skills/<topic>/SKILL.md` is one topic skill. Its frontmatter carries `name`, `description`, `metadata.scope` (`generic` or `repo:<owner>/<name>`) and `metadata.updated`. The body is one short paragraph per memory, each ending in a block id such as `^r7`. Topic names look like `mem-apollo-state` for a repository topic and `mem-any-react-components` for a generic one, and the directory is named after the skill.
- `memory-skills/<topic>/ledger.json` records where each memory came from and the votes it has received. It is never shown to the model.
- `proposals.md` collects lessons that belong in one of your hand-written skills. The writer never edits those skills; it proposes the change for you to review.

The state directory (the `stateDir` setting) sits outside the memory directory because its files change constantly. It holds `usage.jsonl` (which topics were listed, reminded and loaded), `runs.jsonl` (one line per writer run and its outcome), `writer.log`, and the queued writer jobs.

A repository is identified by its normalized git remote, so `git@github.com:preply/apollo.git`, `https://github.com/preply/apollo` and `ssh://git@github.com/preply/apollo` are all `preply/apollo`. Worktrees and separate clones of the same repository therefore share their memory, and the directory name of a checkout never matters.

## Read path

When a session starts, the extension tells pi to list the generic topics and the topics scoped to the repository that contains the working directory. They appear in the skills list exactly like hand-written skills.

Sessions often reach into other repositories. Every time a tool call touches a path (the `path` argument of `read`, `edit`, `write`, `grep`, `find` and `ls`, and absolute paths, `cd` targets and `git -C` targets in `bash`), the extension resolves the path to its git repository. The first time a session touches a repository that has memory topics, it appends one line to that tool result naming the topics and where to read them, for example `[memory] preply/apollo has memory skills: mem-apollo-abstractions, mem-apollo-state — load the ones that apply`. Each repository is announced once per session, and the announced set is cleared after compaction because the earlier reminder may have been summarized away. When your prompt names a repository that has topics, either as `owner/name` or as a bare name of at least four characters, the same reminder is added to that turn as a hidden message.

`user.md` is read once when the session starts and added to the system prompt as its own section on every turn. Because the text is frozen for the session, the prompt prefix stays byte-identical from turn to turn and prompt caching keeps working, and the section survives compaction. Edits to `user.md` take effect in the next session.

The extension records a `reminded` event for each topic named in a reminder and a `loaded` event when the agent reads a topic's `SKILL.md`. These events feed the weights described below.

## Write path

When a session ends, the extension queues a writer for that session's transcript and returns at once, so quitting pi is never delayed. It skips sessions with fewer than `minUserMessages` user messages, and it skips processes where any environment variable in `skipWriteWhenEnv` is set, which by default keeps scheduled jobs and subagents from writing memory. Reading memory still works in those processes. Reloading the extension does not queue a writer, because the session continues.

The writer takes a lock on `.writer.lock` in the memory directory, so writers from several sessions run one after another. The writer holding the lock refreshes its timestamp every minute; another writer takes the lock over only when the holder's process is gone or the timestamp has not been refreshed for 5 minutes, so a long run is never interrupted. It then runs two passes through `pi -p` with extensions, tools, skills and context files turned off, using `writerModel` when it is set and pi's default model otherwise.

The first pass reads a bounded digest of the session: every user message, the final assistant text before each of your messages, the repositories the session touched, the index of memory topics and hand-written skills, `user.md`, and the full text of the topics loaded in that session. It returns candidate lessons with their evidence and a target (`user.md`, an existing topic, a new topic, or a proposal for a hand-written skill), plus votes on the memories it was shown. A lesson counts only when it came from you, through a statement, a correction or a choice, and when it will still be true next month.

The second pass rewrites each touched topic as a whole file. It merges restatements, resolves conflicts by keeping one memory (an explicit statement beats an inference, newer evidence beats older, and higher weight beats lower), and reports what it replaced and why. The extension validates every answer before applying it: the JSON shape, size limits, frontmatter, that every memory id exists, that every existing memory missing from the answer is listed with a reason in what it replaced, that a non-empty `user.md` is not rewritten as empty, and that every write stays inside the memory directory. A rejected answer leaves the topic untouched and is recorded in `runs.jsonl`.

### Runners

The default runner, `detached`, starts the writer as a detached background Node process that outlives pi. It needs nothing else installed.

The `pueue` runner adds the writer to a [pueue](https://github.com/Nukesor/pueue) group (`pueueGroup`, created if missing and limited to one task at a time). Pueue gives you a queue you can inspect with `pueue status`, showing which writers are waiting, running, done or failed. The writer's output still goes to `writer.log` in the state directory. A failed run keeps its job file in the state directory, so `pueue restart <id>` retries it; a successful run deletes its job file. Without pueue you lose the queue view and that retry: the detached runner runs the same writer and the lock serializes it the same way, but a failed detached run is only recorded in `runs.jsonl` and `writer.log`, and its job file stays in the `jobs` directory until you delete it. If `pueue` is selected but not on `PATH`, or the pueue daemon does not answer, the writer falls back to the detached runner and notes it in `writer.log`.

## Ledger, weights and eviction

The extension, not the model, owns the ledger. It mints memory ids from a counter that only increases, so an id is never reused, and after every write it deletes ledger entries whose id is no longer in the topic.

Votes come from the first pass and from usage. `applied` means a memory bore on the work and you did not correct it, `confirmed` means a new lesson repeated it, `ignored` means the agent did not follow it and you corrected the agent toward it, `contradicted` means the agent followed it and you corrected the agent away from it, and `retracted` means you withdrew it, which deletes it at once. A memory's weight is the sum of its votes (applied, confirmed and ignored count +1, contradicted counts −2), each halved every `halfLifeDays`. A topic's weight adds its decayed `loaded` events to its memories' weights. Each ledger keeps the last 20 votes per memory, and for the topic the last 20 `loaded` and the last 20 `reminded` events separately, so frequent reminders never push out the record of a topic being loaded. `reminded` events carry no weight and do not count as loads. An `ignored` vote also tells the writer to reword the topic's description so it gets loaded at the right moment.

Weights only order eviction; nothing is deleted while it is under a cap. When a topic holds more than `maxMemoriesPerTopic` memories, the lowest-weight ones are evicted, except memories younger than `protectNewDays`. When a scope already has `maxGenericTopics` or `maxTopicsPerRepo` topics, a lesson that would open a new topic goes to the closest existing topic instead. A topic that has not been loaded in `staleTopicDays` is merged into a similar topic in the same scope, or removed when there is none.

## Settings

Settings live under the `memory` key in pi's `settings.json`, either `~/.pi/agent/settings.json` or a project's `.pi/settings.json`. Every key is optional.

| Setting | Default | Meaning |
| --- | --- | --- |
| `dir` | `<agentDir>/memory`, usually `~/.pi/agent/memory` | The memory directory. `~` expands, and a relative path resolves against the agent directory. |
| `stateDir` | `${XDG_STATE_HOME:-~/.local/state}/pi-skill-memory` | Usage log, run log, writer log and queued jobs. |
| `writerModel` | unset (pi's default model) | The model the writer passes to `pi -p --model`. |
| `runner` | `detached` | `detached` or `pueue`. |
| `pueueGroup` | `pi-skill-memory` | The pueue group the writer uses. |
| `minUserMessages` | `3` | Sessions with fewer user messages are not written. |
| `maxCharsPerTopic` | `4000` | Maximum size of a topic body. |
| `maxMemoriesPerTopic` | `12` | Memories per topic before eviction. |
| `maxGenericTopics` | `10` | Generic topics before new lessons are routed to existing ones. |
| `maxTopicsPerRepo` | `8` | Topics per repository before new lessons are routed to existing ones. |
| `maxUserChars` | `4000` | Maximum size of `user.md`. |
| `halfLifeDays` | `90` | Days for a vote's weight to halve. |
| `protectNewDays` | `30` | Memories younger than this are never evicted. |
| `staleTopicDays` | `60` | A topic not loaded for this long is merged or removed. |
| `autoCommit` | `true` | Commit each write when the memory directory is in a git repository. |
| `skipWriteWhenEnv` | `["NIGHTSHIFT_JOB", "PI_SUBAGENT_AGENT_ID"]` | Environment variables that turn the writer off for a process. |

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

Point `dir` at a directory inside a git repository to get a history of everything the writer learned and forgot. With `autoCommit` on, each writer run commits its changes, with a message that lists the topics it touched and, for every memory it replaced or evicted, the reason. The commit stages only `user.md`, `memory-skills` and `proposals.md`, and it leaves anything else you have staged alone. The writer commits with your git configuration, so a signing setup that prompts for a passphrase will stall it.

The lock file `.writer.lock` is never committed, but it does appear as an untracked file while a writer runs. Add it to the repository's `.gitignore`:

```gitignore
.writer.lock
```

## Installing

Install the published package with `pi install npm:pi-skill-memory`.

Before it is published, install it from a local checkout by its absolute path, for example `pi install /Users/you/code/pi-skill-memory`. pi records the path in `~/.pi/agent/settings.json` and loads the extension from the checkout without copying it. pi does not run `npm install` for local packages, so the checkout's `node_modules` is yours to manage. The extension has no runtime dependencies, so it loads without one; run `npm install` in the checkout yourself when you want to run the tests or the typecheck. To try the extension for one session without saving it, run `pi -e /Users/you/code/pi-skill-memory`.

pi loads the extension's TypeScript directly. The writer runs as a separate Node process, which needs Node 22.18 or newer. Node refuses to strip types from files under `node_modules`, so the published package also ships the writer compiled to `dist/`, built by `npm pack` and `npm publish`. The writer runs `dist/writer/main.js` when it exists and `src/writer/main.ts` otherwise. In a local checkout where you have run `npm run build`, delete `dist/` or rebuild it after editing the writer, or the writer will keep running the old build.

## Commands

- `/memory status` shows the memory and state directories, whether `user.md` exists, how many topics each scope has, the last writer run with its outcome, and the runner, including whether `pueue` is on `PATH`. `/memory` on its own does the same.
- `/memory explain` shows which topics pi currently lists and why (pi refreshes that listing at startup and on `/reload`, not on `/new` or `/resume`, so it can still reflect the directory pi started in), and which topics were named in reminders and what triggered each one: the tool call and path, or the word in your prompt.
- `/memory write` queues the writer for the current session now, even when the session has fewer than `minUserMessages` user messages or a variable in `skipWriteWhenEnv` is set. Quitting afterwards does not queue the same session again unless you have continued it.

## License

MIT
