import { spawn as nodeSpawn } from "node:child_process";

export type ModelRunner = (prompt: string) => Promise<string>;

export type SpawnFunction = typeof nodeSpawn;

export interface PiRunnerOptions {
  model?: string;
  command?: string;
  cwd?: string;
  timeoutMs?: number;
  spawn?: SpawnFunction;
}

export const PI_WRITER_FLAGS = ["-p", "--no-extensions", "--no-tools", "--no-session", "--no-skills", "--no-context-files"];

const DEFAULT_TIMEOUT_MS = 10 * 60_000;

export function piArgs(model: string | undefined): string[] {
  return model ? [...PI_WRITER_FLAGS, "--model", model] : [...PI_WRITER_FLAGS];
}

export function createPiRunner(options: PiRunnerOptions = {}): ModelRunner {
  const spawn = options.spawn ?? nodeSpawn;
  const command = options.command ?? "pi";
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return (prompt) =>
    new Promise((resolve, reject) => {
      const child = spawn(command, piArgs(options.model), {
        cwd: options.cwd,
        stdio: ["pipe", "pipe", "pipe"],
        env: process.env,
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error: Error | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (error) reject(error);
        else resolve(stdout);
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(new Error(`${command} timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.on("error", (error) => finish(error));
      child.on("close", (code) => {
        if (code === 0) finish(null);
        else finish(new Error(`${command} exited with ${code}: ${stderr.trim().slice(-500)}`));
      });
      child.stdin?.on("error", () => undefined);
      child.stdin?.end(prompt);
    });
}

export class ModelOutputError extends Error {}

export function extractJson(output: string): unknown {
  let text = output.trim();
  const fenced = /```(?:json|JSON)?[ \t]*\r?\n([\s\S]*?)\r?\n?```/.exec(text);
  if (fenced) text = fenced[1]!.trim();
  if (!text.startsWith("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start < 0 || end < start) throw new ModelOutputError("model output holds no JSON object");
    text = text.slice(start, end + 1);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new ModelOutputError(`model output is not valid JSON: ${(error as Error).message}`);
  }
}
