export const INPUT_SOURCES = ["interactive", "rpc", "extension"] as const;
export const DEFAULT_LEARN_FROM_SOURCES: InputSource[] = ["interactive"];
export const INPUT_MARK_TYPE = "pi-skill-memory-input";

export type InputSource = (typeof INPUT_SOURCES)[number];
export type StreamingBehavior = "steer" | "followUp";

export interface InputMark {
  messageTimestamp: number;
  source: InputSource;
  mode: string;
}

export interface PendingInput {
  text: string;
  source: InputSource;
  mode: string;
  streamingBehavior: StreamingBehavior | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isInputSource(value: unknown): value is InputSource {
  return typeof value === "string" && (INPUT_SOURCES as readonly string[]).includes(value);
}

export function isHumanInput(mark: Pick<InputMark, "source" | "mode">, learnFromSources: readonly InputSource[]): boolean {
  if (!learnFromSources.includes(mark.source)) return false;
  return mark.source !== "interactive" || mark.mode === "tui";
}

export function messageText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((block): block is { type: "text"; text: string } => isRecord(block) && block.type === "text" && typeof block.text === "string")
    .map((block) => block.text)
    .join("\n");
}

const DELIVERY_ORDER: (StreamingBehavior | undefined)[] = [undefined, "steer", "followUp"];

export function rememberInput(pending: PendingInput[], input: PendingInput): void {
  if (input.streamingBehavior === undefined) {
    for (let index = pending.length - 1; index >= 0; index--) {
      if (pending[index]!.streamingBehavior === undefined) pending.splice(index, 1);
    }
  }
  pending.push(input);
}

export function takeInputFor(pending: PendingInput[], text: string): PendingInput | undefined {
  const matchers: ((input: PendingInput) => boolean)[] = [
    (input) => input.text === text,
    (input) => input.text !== "" && text.startsWith(input.text),
    ...DELIVERY_ORDER.map((behavior) => (input: PendingInput) => input.streamingBehavior === behavior),
  ];
  for (const matches of matchers) {
    const index = pending.findIndex(matches);
    if (index !== -1) return pending.splice(index, 1)[0];
  }
  return undefined;
}

export function readInputMark(entry: unknown): InputMark | null {
  if (!isRecord(entry) || entry.type !== "custom" || entry.customType !== INPUT_MARK_TYPE || !isRecord(entry.data)) return null;
  const { messageTimestamp, source, mode } = entry.data;
  if (typeof messageTimestamp !== "number" || !isInputSource(source) || typeof mode !== "string") return null;
  return { messageTimestamp, source, mode };
}

export function humanMessageTimestamps(entries: readonly unknown[], learnFromSources: readonly InputSource[]): Set<number> {
  const timestamps = new Set<number>();
  for (const entry of entries) {
    const mark = readInputMark(entry);
    if (mark && isHumanInput(mark, learnFromSources)) timestamps.add(mark.messageTimestamp);
  }
  return timestamps;
}

export function isUserMessageFrom(entry: unknown, humanTimestamps: ReadonlySet<number>): boolean {
  if (!isRecord(entry) || entry.type !== "message" || !isRecord(entry.message)) return false;
  const message = entry.message;
  return message.role === "user" && typeof message.timestamp === "number" && humanTimestamps.has(message.timestamp);
}

export function countHumanMessages(entries: readonly unknown[], learnFromSources: readonly InputSource[]): number {
  const humanTimestamps = humanMessageTimestamps(entries, learnFromSources);
  return entries.filter((entry) => isUserMessageFrom(entry, humanTimestamps)).length;
}
