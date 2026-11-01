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
  /** 渲染时是否裁剪过任何 part；解压工具据此把 truncated 传给模型，不能假装原文完整。 */
  truncated?: boolean;
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
    // postCompactTokenCount 取折叠那一刻的估算值，随后 replaceMessages 才真正瘦身，
    // 所以它常常和 pre 相差无几；truePostCompactTokenCount 才是折叠后的实际上下文。
    postCompactTokenCount: boundary.truePostCompactTokenCount ?? boundary.postCompactTokenCount,
    preCompactTokenCount: boundary.preCompactTokenCount,
    summarizedMessageCount: boundary.summarizedMessageCount,
    // 一个边界可能带多个 summary id（分层折叠时）；展示层取最近的一个。
    summaryMessageId: boundary.summaryMessageIds?.at(-1) ?? partSummaryMessageId,
    trigger: boundary.trigger,
  };
}

export function renderStoredMessage(
  message: MessageWithParts,
  options: { toolOutputMaxChars?: number } = {},
): RenderedMessage {
  const blocks: string[] = [];
  let truncated = false;
  const toolOutputMax = options.toolOutputMaxChars ?? TOOL_OUTPUT_MAX;
  for (const part of message.parts) {
    if (part.type === "text") {
      // 合成文本（summary、system reminder 渲染结果）不是模型原话，但仍然是上下文的一部分；
      // 只有 `ignored` 明确表示不进入模型上下文。
      if (part.ignored === true) continue;
      if (part.text.trim()) blocks.push(part.text.trim());
      continue;
    }
    if (part.type === "tool") {
      const rendered = renderToolPart(part, toolOutputMax);
      if (rendered.text) blocks.push(rendered.text);
      truncated ||= rendered.truncated;
    }
  }
  return {
    createdAt: message.info.time.created,
    messageId: message.info.id,
    role: message.info.role,
    text: blocks.join("\n"),
    ...(truncated ? { truncated: true } : {}),
  };
}

function renderToolPart(part: ToolPart, outputMaxChars: number): { text: string; truncated: boolean } {
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
  if (error) {
    const clipped = clipWithFlag(error, outputMaxChars);
    return { text: `${head} input: ${input || "-"} error: ${clipped.text}`, truncated: clipped.truncated };
  }
  if (output) {
    const clipped = clipWithFlag(output, outputMaxChars);
    return { text: `${head} input: ${input || "-"} output: ${clipped.text}`, truncated: clipped.truncated };
  }
  return { text: `${head} input: ${input || "-"}`, truncated: false };
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
  // 用原串做大小写不敏感查找：先 toLowerCase 再拿下标，遇到会变长的字母（如 İ）会切错位置。
  const anchor = firstMatchIndex(rendered.text, query, terms);
  if (anchor < 0) return clip(rendered.text.trim(), SNIPPET_RADIUS * 2);
  const start = Math.max(0, anchor - SNIPPET_RADIUS);
  const end = Math.min(rendered.text.length, anchor + SNIPPET_RADIUS);
  const prefix = start > 0 ? "…" : "";
  const suffix = end < rendered.text.length ? "…" : "";
  return `${prefix}${rendered.text.slice(start, end).trim()}${suffix}`;
}

function firstMatchIndex(text: string, query: string, terms: readonly string[]): number {
  const queryIndex = indexOfCaseInsensitive(text, query);
  if (queryIndex >= 0) return queryIndex;
  let best = -1;
  for (const term of terms) {
    const index = indexOfCaseInsensitive(text, term);
    if (index >= 0 && (best < 0 || index < best)) best = index;
  }
  return best;
}

function indexOfCaseInsensitive(text: string, needle: string): number {
  if (needle.length === 0) return -1;
  const lower = text.toLowerCase();
  // toLowerCase 会变长时（如 İ → i̇），lower 的下标与原串错位；退回精确查找，
  // 宁可不命中，也不从错误位置切片段。
  if (lower.length !== text.length) return text.indexOf(needle);
  return lower.indexOf(needle);
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

/**
 * 边界窗口里仍留在 provider 上下文中的消息：保留段、请求前公告、上一代摘要。
 * 这些不是 folded，检索不该标、解压不该重复注入。
 */
export function keptMessageIdsForRange(
  messages: readonly MessageWithParts[],
  range: CompactedRange,
): Set<string> {
  const kept = new Set<string>();
  const boundaryMessage = messages[range.messageIndex];
  if (!boundaryMessage) return kept;
  for (const part of boundaryMessage.parts) {
    if (part.type !== "compaction" || !part.compactBoundary) continue;
    const metadata = part.metadata as Record<string, unknown> | undefined;
    for (const key of ["compactLeadingMessageIds", "compactRetainedMessageIds"]) {
      const ids = metadata?.[key];
      if (!Array.isArray(ids)) continue;
      for (const id of ids) if (typeof id === "string") kept.add(id);
    }
    const segment = part.compactBoundary.preservedSegment;
    if (!segment) continue;
    const head = messages.findIndex((message) => message.info.id === segment.headMessageId);
    const tail = messages.findIndex((message) => message.info.id === segment.tailMessageId);
    if (head >= 0 && tail >= head && tail < range.messageIndex) {
      for (let index = head; index <= tail; index += 1) kept.add(messages[index]!.info.id);
    }
  }
  return kept;
}

/** 真正被折叠掉的消息下标（窗口减去仍活跃的保留段/公告/旧摘要）。 */
export function collectFoldedMessageIndexes(
  messages: readonly MessageWithParts[],
  ranges: readonly CompactedRange[],
): Set<number> {
  const folded = new Set<number>();
  const lastRange = ranges.at(-1);
  if (!lastRange) return folded;
  // folded 的语义是「当前 provider 历史里已不存在」。当前历史就等于：
  // 最后一个 boundary 声明的 kept（公告 + 保留摘要 + 保留段）+ boundary 本身及其之后。
  // 逐层用各自 boundary 的 kept 会误标：被上限裁掉的旧摘要层、更早的 summary 行
  // 还挂在自己的 boundary 声明里，实际已经不在上下文。
  const kept = keptMessageIdsForRange(messages, lastRange);
  for (let index = 0; index < lastRange.messageIndex; index += 1) {
    const message = messages[index];
    if (message && !kept.has(message.info.id)) folded.add(index);
  }
  return folded;
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

function clipWithFlag(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: clip(text, max), truncated: true };
}
