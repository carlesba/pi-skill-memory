import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export type RunnerKind = "detached" | "pueue";

export interface MemoryConfig {
  agentDir: string;
  dir: string;
  stateDir: string;
  writerModel: string | undefined;
  runner: RunnerKind;
  pueueGroup: string;
  minUserMessages: number;
  maxCharsPerTopic: number;
  maxMemoriesPerTopic: number;
  maxGenericTopics: number;
  maxTopicsPerRepo: number;
  maxUserChars: number;
  halfLifeDays: number;
  protectNewDays: number;
  staleTopicDays: number;
  autoCommit: boolean;
  skipWriteWhenEnv: string[];
}

export interface ConfigEnvironment {
  env?: Record<string, string | undefined>;
  home?: string;
}

export const DEFAULT_SKIP_WRITE_WHEN_ENV = ["NIGHTSHIFT_JOB", "PI_SUBAGENT_AGENT_ID"];

const numericDefaults = {
  minUserMessages: 3,
  maxCharsPerTopic: 4000,
  maxMemoriesPerTopic: 12,
  maxGenericTopics: 10,
  maxTopicsPerRepo: 8,
  maxUserChars: 4000,
  halfLifeDays: 90,
  protectNewDays: 30,
  staleTopicDays: 60,
} as const;

type NumericKey = keyof typeof numericDefaults;

export function expandHome(path: string, home: string): string {
  if (path === "~") return home;
  if (path.startsWith("~/")) return join(home, path.slice(2));
  return path;
}

function resolveSettingPath(path: string, home: string, base: string): string {
  const expanded = expandHome(path, home);
  return isAbsolute(expanded) ? expanded : resolve(base, expanded);
}

export function resolveAgentDir(environment: ConfigEnvironment = {}): string {
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  const override = env.PI_CODING_AGENT_DIR;
  if (override) return expandHome(override, home);
  return join(home, ".pi", "agent");
}

export function resolveDefaultStateDir(environment: ConfigEnvironment = {}): string {
  const env = environment.env ?? process.env;
  const home = environment.home ?? homedir();
  const stateHome = env.XDG_STATE_HOME ? expandHome(env.XDG_STATE_HOME, home) : join(home, ".local", "state");
  return join(stateHome, "pi-skill-memory");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function nonNegativeNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function readMemorySettings(settings: unknown): Record<string, unknown> {
  if (!isRecord(settings)) return {};
  const memory = settings.memory;
  return isRecord(memory) ? memory : {};
}

export function resolveConfig(settings: unknown, environment: ConfigEnvironment = {}): MemoryConfig {
  const home = environment.home ?? homedir();
  const memory = readMemorySettings(settings);
  const agentDir = resolveAgentDir(environment);
  const dirSetting = nonEmptyString(memory.dir);
  const stateDirSetting = nonEmptyString(memory.stateDir);
  const numbers = {} as Record<NumericKey, number>;
  for (const key of Object.keys(numericDefaults) as NumericKey[]) {
    numbers[key] = nonNegativeNumber(memory[key], numericDefaults[key]);
  }
  const skip = Array.isArray(memory.skipWriteWhenEnv)
    ? memory.skipWriteWhenEnv.filter((name): name is string => typeof name === "string" && name !== "")
    : [...DEFAULT_SKIP_WRITE_WHEN_ENV];
  return {
    agentDir,
    dir: dirSetting ? resolveSettingPath(dirSetting, home, agentDir) : join(agentDir, "memory"),
    stateDir: stateDirSetting ? resolveSettingPath(stateDirSetting, home, agentDir) : resolveDefaultStateDir(environment),
    writerModel: nonEmptyString(memory.writerModel),
    runner: memory.runner === "pueue" ? "pueue" : "detached",
    pueueGroup: nonEmptyString(memory.pueueGroup) ?? "pi-skill-memory",
    ...numbers,
    autoCommit: typeof memory.autoCommit === "boolean" ? memory.autoCommit : true,
    skipWriteWhenEnv: skip,
  };
}

export function shouldSkipWrite(config: MemoryConfig, env: Record<string, string | undefined> = process.env): boolean {
  return config.skipWriteWhenEnv.some((name) => Boolean(env[name]));
}
