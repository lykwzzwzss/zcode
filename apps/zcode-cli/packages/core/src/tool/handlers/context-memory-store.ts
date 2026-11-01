import type { CompactBoundaryPayload, MessageWithParts, ToolPart } from "@zcode/contracts";

// 折叠后的历史只在 Runtime 里被替换掉，SQLite 的 message/part 行一律保留。
// 这一层负责把「磁盘上的原文」重新变成可读文本，供 SearchContext / DecompressContext 使用。

export interface CompactedRange {
  boundaryId: string;
  messageId: string;
  summaryMessageId?: string;
  lastSummarizedMessageId?: string;
  summarizedMessageCount: number;
  preCompactTokenCount?: number;
  postCompactTokenCount?: number;
  trigger?: string;
  phase?: string;
  createdAt: number;
  messageIndex: number;
}

export interface RenderedMessage {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number;
  text: string;
}

const SNIPPET_RADIUS = 220;
const TOOL_INPUT_MAX = 240;
const TOOL_OUTPUT_MAX = 1200;

export function collectCompactedRanges(messages: readonly MessageWithParts[]): CompactedRange[] {
  const ranges: CompactedRange[] = [];
  messages.forEach((message, messageIndex) => {
    for (const part of message.parts) {
      if (part.type !== "compaction") continue;
      const boundary = part.compactBoundary;
      // timelineStatus 那一片只是 UI 回放痕迹（started/completed 各一片），
      // 只有真正落地的那一片带 compactBoundary。拿错会把边界算成两段。
      if (!boundary) continue;
      ranges.push(toRange(boundary, message, messageIndex, part.summaryMessageId));
    }
  });
  return ranges;
}

function toRange(
  boundary: CompactBoundaryPayload,
  message: MessageWithParts,
  messageIndex: number,
  partSummaryMessageId: string | undefined,
): CompactedRange {
  return {
    boundaryId: boundary.boundaryId,
    createdAt: message.info.time.created,
    lastSummarizedMessageId: boundary.lastSummarizedMessageId,
    messageId: message.info.id,
    messageIndex,
    phase: boundary.phase,
    postCompactTokenCount: boundary.postCompactTokenCount,
    preCompactTokenCount: boundary.preCompactTokenCount,
    summarizedMessageCount: boundary.summarizedMessageCount,
    // 一个边界可能带多个 summary id（分层折叠时）；展示层取最近的一个。
    summaryMessageId: boundary.summaryMessageIds?.at(-1) ?? partSummaryMessageId,
    trigger: boundary.trigger,
  };
}

export function renderStoredMessage(message: MessageWithParts): RenderedMessage {
  const blocks: string[] = [];
  for (const part of message.parts) {
    if (part.type === "text") {
      // 合成文本（summary、system reminder 渲染结果）不是模型原话，但仍然是上下文的一部分；
      // 只有 `ignored` 明确表示不进入模型上下文。
      if (part.ignored === true) continue;
      if (part.text.trim()) blocks.push(part.text.trim());
      continue;
    }
    if (part.type === "tool") {
      const rendered = renderToolPart(part);
      if (rendered) blocks.push(rendered);
    }
  }
  return {
    createdAt: message.info.time.created,
    messageId: message.info.id,
    role: message.info.role,
    text: blocks.join("\n"),
  };
}

function renderToolPart(part: ToolPart): string {
  // ToolState 是联合类型，这里只需要「发生了什么」，用结构化读取避免为展示层引入依赖。
  const state = part.state as unknown as {
    error?: unknown;
    input?: unknown;
    output?: unknown;
    status?: string;
  };
  const head = `[tool ${part.tool}${typeof state.status === "string" ? ` ${state.status}` : ""}]`;
  const input = summarizeToolInput(state.input);
  const error = typeof state.error === "string" ? state.error.trim() : "";
  const output = typeof state.output === "string" ? state.output.trim() : "";
  if (error) return `${head} input: ${input || "-"} error: ${clip(error, TOOL_OUTPUT_MAX)}`;
  if (output) return `${head} input: ${input || "-"} output: ${clip(output, TOOL_OUTPUT_MAX)}`;
  return `${head} input: ${input || "-"}`;
}

function summarizeToolInput(input: unknown): string {
  if (input === undefined || input === null) return "";
  if (typeof input !== "object") return clip(String(input), TOOL_INPUT_MAX);
  const record = input as Record<string, unknown>;
  const picked: string[] = [];
  for (const key of [
    "file_path",
    "path",
    "pattern",
    "command",
    "cmd",
    "description",
    "query",
    "url",
  ]) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) picked.push(`${key}=${clip(value, 120)}`);
  }
  if (picked.length > 0) return clip(picked.join(" "), TOOL_INPUT_MAX);
  const keys = Object.keys(record).slice(0, 6);
  return keys.length > 0 ? `{${keys.join(",")}}` : "";
}

export function scoreMessage(rendered: RenderedMessage, query: string, terms: readonly string[]): number {
  if (rendered.text.length === 0) return 0;
  const haystack = rendered.text.toLowerCase();
  let score = 0;
  if (haystack.includes(query)) score += 20;
  for (const term of terms) {
    let index = haystack.indexOf(term);
    let hits = 0;
    while (index !== -1 && hits < 12) {
      hits += 1;
      score += 3;
      index = haystack.indexOf(term, index + term.length);
    }
  }
  return score;
}

export function buildSnippet(rendered: RenderedMessage, query: string, terms: readonly string[]): string {
  const haystack = rendered.text.toLowerCase();
  const anchor = firstMatchIndex(haystack, query, terms);
  if (anchor < 0) return clip(rendered.text.trim(), SNIPPET_RADIUS * 2);
  const start = Math.max(0, anchor - SNIPPET_RADIUS);
  const end = Math.min(rendered.text.length, anchor + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < rendered.text.length ? "…" : "";
  return `${prefix}${rendered.text.slice(start, end).trim()}${suffix}`;
}

function firstMatchIndex(haystack: string, query: string, terms: readonly string[]): number {
  const queryIndex = haystack.indexOf(query);
  if (queryIndex >= 0) return queryIndex;
  let best = -1;
  for (const term of terms) {
    const index = haystack.indexOf(term);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

/**
 * 某个边界折叠掉的区间：从上一次边界所在消息之后，到这次边界所在消息之前。
 * 边界消息本身（summary）和它之后的保留段都不在区间内。
 */
export function foldedWindowForRange(
  ranges: readonly CompactedRange[],
  range: CompactedRange,
): { start: number; end: number } {
  const previous = ranges.filter((item) => item.messageIndex < range.messageIndex).at(-1);
  return {
    start: (previous?.messageIndex ?? -1) + 1,
    end: range.messageIndex,
  };
}

export function tokenize(query: string): string[] {
  const normalized = query.toLowerCase().trim();
  const parts = normalized.split(/\s+/u).filter((term) => term.length > 0);
  // CJK 查询通常不带空格：整串已经作为 query 参与计分，这里再补 2 字以上的滑窗提高召回。
  const cjk = [...normalized].filter((char) => /[\u4e00-\u9fff]/u.test(char)).join("");
  if (cjk.length >= 4) {
    for (let index = 0; index + 2 <= cjk.length; index += 2) {
      parts.push(cjk.slice(index, index + 2));
    }
  }
  return [...new Set(parts)];
}

export function clip(text: string, max: number): string {
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}
