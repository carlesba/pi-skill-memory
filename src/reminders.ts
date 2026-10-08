import { repoName } from "./repo.ts";
import { repoTopics, scopeIdentity, topicsRoot, type TopicSummary } from "./topics.ts";

export const MIN_BARE_NAME_LENGTH = 4;

export interface PromptRepoMatch {
  identity: string;
  matched: string;
}

const NAME_CHAR = "A-Za-z0-9_-";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function findBounded(text: string, needle: string): string | null {
  const pattern = new RegExp(`(?<![${NAME_CHAR}])${escapeRegExp(needle)}(?![${NAME_CHAR}])`, "i");
  const match = pattern.exec(text);
  return match ? match[0] : null;
}

export function knownRepoIdentities(topics: TopicSummary[]): string[] {
  const identities = new Set<string>();
  for (const topic of topics) {
    const identity = scopeIdentity(topic.scope);
    if (identity) identities.add(identity);
  }
  return [...identities].sort();
}

export function promptNamedRepos(prompt: string, identities: string[]): PromptRepoMatch[] {
  const matches: PromptRepoMatch[] = [];
  for (const identity of identities) {
    const full = findBounded(prompt, identity);
    if (full) {
      matches.push({ identity, matched: full });
      continue;
    }
    const name = repoName(identity);
    if (name.length < MIN_BARE_NAME_LENGTH) continue;
    const bare = findBounded(prompt, name);
    if (bare) matches.push({ identity, matched: bare });
  }
  return matches;
}

export function reminderTopics(topics: TopicSummary[], identity: string): string[] {
  return repoTopics(topics, identity).map((topic) => topic.name);
}

export function reminderLine(identity: string, names: string[], dir: string): string {
  return `[memory] ${identity} has memory skills: ${names.join(", ")} — load the ones that apply (each is ${topicsRoot(dir)}/<name>/SKILL.md).`;
}
