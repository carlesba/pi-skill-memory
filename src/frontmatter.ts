export interface ParsedFrontmatter {
  fields: Record<string, string>;
  maps: Record<string, Record<string, string>>;
  body: string;
}

const KEY_LINE = /^([A-Za-z0-9_.-]+):(?:[ \t]+(.*))?$/;

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) {
    try {
      return JSON.parse(trimmed) as string;
    } catch {
      return trimmed.slice(1, -1);
    }
  }
  if (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2) {
    return trimmed.slice(1, -1).replace(/''/g, "'");
  }
  return trimmed.replace(/\s+#.*$/, "");
}

function readBlockScalar(indicator: string, lines: string[]): string {
  const style = indicator[0];
  const chomp = indicator.includes("-") ? "strip" : indicator.includes("+") ? "keep" : "clip";
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const indent = nonEmpty.length === 0 ? 0 : Math.min(...nonEmpty.map(indentOf));
  const content = lines.map((line) => line.slice(Math.min(indent, indentOf(line))));
  let text: string;
  if (style === "|") {
    text = content.join("\n");
  } else {
    const paragraphs: string[] = [];
    let current: string[] = [];
    for (const line of content) {
      if (line.trim() === "") {
        paragraphs.push(current.join(" "));
        current = [];
      } else {
        current.push(line.trim());
      }
    }
    paragraphs.push(current.join(" "));
    text = paragraphs.join("\n").replace(/\n+$/, "");
  }
  const stripped = text.replace(/\n+$/, "");
  if (chomp === "strip") return stripped;
  if (chomp === "keep") return text.endsWith("\n") ? text : `${text}\n`;
  return stripped === "" ? "" : `${stripped}\n`;
}

function readValue(rest: string | undefined, continuation: string[]): string {
  const value = rest?.trim() ?? "";
  if (/^[|>][+-]?$/.test(value)) return readBlockScalar(value, continuation).replace(/\n$/, "");
  const extra = continuation.map((line) => line.trim()).filter((line) => line !== "");
  if (extra.length === 0) return unquote(value);
  return unquote([value, ...extra].join(" "));
}

export function splitFrontmatter(raw: string): { frontmatter: string; body: string } | null {
  const text = raw.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  if (!text.startsWith("---\n")) return null;
  const end = text.indexOf("\n---", 3);
  if (end < 0) return null;
  const afterMarker = text.slice(end + 4);
  if (afterMarker !== "" && !afterMarker.startsWith("\n")) return null;
  return { frontmatter: text.slice(4, end), body: afterMarker.replace(/^\n/, "") };
}

export function parseFrontmatter(raw: string): ParsedFrontmatter | null {
  const split = splitFrontmatter(raw);
  if (!split) return null;
  const lines = split.frontmatter.split("\n");
  const fields: Record<string, string> = {};
  const maps: Record<string, Record<string, string>> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const match = indentOf(line) === 0 ? KEY_LINE.exec(line) : null;
    index++;
    if (!match) continue;
    const key = match[1]!;
    const rest = match[2];
    const continuation: string[] = [];
    while (index < lines.length && (lines[index]!.trim() === "" || indentOf(lines[index]!) > 0)) {
      continuation.push(lines[index]!);
      index++;
    }
    const isMap = (rest === undefined || rest.trim() === "") && continuation.some((entry) => KEY_LINE.test(entry.trim()));
    if (isMap) {
      maps[key] = parseNestedMap(continuation);
    } else {
      fields[key] = readValue(rest, continuation);
    }
  }
  return { fields, maps, body: split.body };
}

function parseNestedMap(lines: string[]): Record<string, string> {
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  const indent = nonEmpty.length === 0 ? 0 : indentOf(nonEmpty[0]!);
  const map: Record<string, string> = {};
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    index++;
    if (line.trim() === "" || indentOf(line) !== indent) continue;
    const match = KEY_LINE.exec(line.trim());
    if (!match) continue;
    const continuation: string[] = [];
    while (index < lines.length && (lines[index]!.trim() === "" || indentOf(lines[index]!) > indent)) {
      continuation.push(lines[index]!);
      index++;
    }
    map[match[1]!] = readValue(match[2], continuation);
  }
  return map;
}

export function quoteScalar(value: string): string {
  return JSON.stringify(value);
}
