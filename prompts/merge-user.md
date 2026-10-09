# Rewrite the user memory

You maintain `user.md`: what a coding agent should know about how this user works in every repository. It is injected into every session. Merge the new candidates into the existing memories and return the whole file as JSON only.

## Rules

- Keep only memories that hold in every repository.
- A restatement of an existing memory: keep one memory, worded more precisely, under the existing id.
- Conflicts: resolve every conflict yourself and keep exactly one memory. A human memory always beats an observed one, whatever their age or weight. Between two memories of the same origin, decide in this order: an explicit user statement beats an inference, newer evidence beats older, higher weight beats lower. New candidates are human. Record each memory you replaced or dropped in `removed`, with its id and why.
- Each memory is one short paragraph ending in its id: `^r<N>` for an existing memory, `^new` for a new one. Use only the existing ids listed below, and each one at most once. Separate paragraphs with one blank line. No headings, lists or sections.
- The body has at most {maxUserChars} characters. When over: first merge overlapping memories, then drop the lowest-weight ones. Memories still over the limit are evicted lowest weight first.

## Output

Return one JSON object and nothing else, with no prose and no code fence:

{"body": "First memory paragraph. ^r3\n\nSecond memory paragraph. ^new", "removed": [{"id": "r5", "why": "..."}]}

## Existing memories

Each memory shows its id, its origin, its weight (higher means it has been applied or confirmed more) and the date it was learned. The origin is `human` when the memory came from what the user said and `observed` when it came from what the agent saw in the work.

{memories}

## New candidates

{candidates}
