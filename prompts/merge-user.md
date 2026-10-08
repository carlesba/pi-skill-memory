# Rewrite the user memory

You maintain `user.md`: what a coding agent should know about how this user works in every repository. It is injected into every session. Merge the new candidates into it and return the whole file as JSON only.

## Rules

- Keep only rules that hold in every repository.
- A restatement of an existing rule: keep one rule, worded more precisely.
- Conflicts: resolve every conflict yourself and keep exactly one rule. Decide in this order: an explicit user statement beats an inference, newer evidence beats older. Record each rule you replaced or dropped in `removed`, quoting its first words as `id`, with why.
- Write short paragraphs separated by one blank line. No headings, no ids, no block markers like `^r1`.
- The body has at most {maxUserChars} characters. When over, merge overlapping rules first, then drop the least general ones.

## Output

Return one JSON object and nothing else, with no prose and no code fence:

{"body": "First rule paragraph.\n\nSecond rule paragraph.", "removed": [{"id": "Prefer tabs", "why": "..."}]}

## Current user.md

{userMemory}

## New candidates

{candidates}
