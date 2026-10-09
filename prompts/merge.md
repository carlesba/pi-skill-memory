# Rewrite one memory topic

You maintain one topic of a coding agent's long-term memory. Merge the new candidates into the existing memories and return the whole topic as JSON only.

## Rules

- A restatement of an existing memory: keep one memory, worded more precisely, under the existing id.
- Conflicts: resolve every conflict yourself and keep exactly one memory. A human memory always beats an observed one, whatever their age or weight. Between two memories of the same origin, decide in this order: an explicit user statement beats an inference, newer evidence beats older, higher weight beats lower. New candidates are human. Record each memory you replaced or dropped in `removed`, with its id and why.
- Each memory is one short paragraph ending in its id: `^r<N>` for an existing memory, `^new` for a new one. Use only the existing ids listed below, and each one at most once. Separate paragraphs with one blank line. No headings, lists or sections.
- Link a closely related topic as `../<name>/SKILL.md` only when a memory needs it.
- The description says when to load the topic. It names the trigger moment and the scope, in at most {maxDescriptionChars} characters. Rewrite it when the memories outgrow it or when it is flagged below.
- The body has at most {maxCharsPerTopic} characters and should hold at most {maxMemoriesPerTopic} memories. When over: first merge overlapping memories, then drop the lowest-weight ones. If the topic holds two distinct trigger moments, name the natural split in `split`. Otherwise `split` is null.

## Output

Return one JSON object and nothing else, with no prose and no code fence:

{"description": "...", "body": "First memory paragraph. ^r3\n\nSecond memory paragraph. ^new", "removed": [{"id": "r5", "why": "..."}], "split": null}

## Topic

- Name: {topicName}
- Scope: {scope}
- Current description: {description}
- Description flags: {descriptionFlags}

## Existing memories

Each memory shows its id, its origin, its weight (higher means it has been applied or confirmed more) and the date it was learned. The origin is `human` when the memory came from what the user said and `observed` when it came from what the agent saw in the work.

{memories}

## New candidates

{candidates}

## Related topics in the same scope

{relatedTopics}
