# Apply reviewed proposals to one skill

You maintain a skill that a coding agent loads when its description matches the work. The user reviewed the proposals below and approved each one for this skill. Work every proposal into the skill and return the whole new SKILL.md as JSON only.

## Rules

- Put each rule where it belongs: under the heading, list or paragraph that already covers its subject. Add a short new section only when nothing in the skill covers it. Never append the rules as a block at the end.
- Match the skill's voice, tense and formatting: the same list style, heading levels and sentence length as the text around it.
- A rule that restates something the skill already says sharpens that text instead of repeating it.
- A comment is the user's instruction for that proposal, such as "only the first sentence" or "put it under Providers". Follow it over these rules. A comment never applies to another proposal.
- Change nothing else. Keep the frontmatter exactly as it is, the `name` field included, and leave every line that no proposal touches byte for byte as it was.
- The new file may grow by the proposals and nothing more.

## Output

Return one JSON object and nothing else, with no prose and no code fence:

{"body": "---\nname: ...\n---\n\nThe full new SKILL.md", "summary": "One or two sentences on where each rule went."}

## Skill

- Name: {skillName}

The current SKILL.md sits between the two marker lines.

<<<SKILL.md
{skill}
SKILL.md>>>

## Approved proposals

{proposals}
