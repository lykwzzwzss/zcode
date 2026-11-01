import {
  CONTEXT_MEMORY_DEFAULT_MAX_CHARS,
  CoreErrorType,
  SEARCH_CONTEXT_TOOL_NAME,
  SearchContextInputJsonSchema,
  SearchContextInputSchema,
  SearchContextOutputJsonSchema,
  SearchContextOutputSchema,
  createCoreError,
  type SearchContextOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  buildSnippet,
  clip,
  collectCompactedRanges,
  foldedWindowForRange,
  renderStoredMessage,
  scoreMessage,
  tokenize,
} from "./context-memory-store.js";

const MAX_MODEL_BYTES = 80_000;
const TIMEOUT_MS = 30_000;

export const searchContextHandler: ToolHandler = async (input, context) => {
  const parsed = SearchContextInputSchema.parse(input);
  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for SearchContext",
      { context: { toolName: SEARCH_CONTEXT_TOOL_NAME }, recoverable: false },
    );
  }

  const query = parsed.query.toLowerCase().trim();
  const terms = tokenize(parsed.query);
  const budget = parsed.maxChars ?? CONTEXT_MEMORY_DEFAULT_MAX_CHARS;

  let messages;
  try {
    messages = await context.sessionStore.messages({ sessionID: context.sessionId });
  } catch (error) {
    return {
      error: error instanceof Error ? error.message : String(error),
      foldedMessageCount: 0,
      matches: [],
      query: parsed.query,
      searchedMessageCount: 0,
      sessionId: context.sessionId,
      status: "failed",
      truncated: false,
    } satisfies SearchContextOutput;
  }

  const ranges = collectCompactedRanges(messages);
  const foldedWindows = ranges.map((range) => foldedWindowForRange(ranges, range));
  const isFolded = (index: number): boolean =>
    foldedWindows.some((window) => index >= window.start && index < window.end);

  const scored: Array<{
    messageId: string;
    role: "user" | "assistant";
    createdAt: number;
    folded: boolean;
    score: number;
    snippet: string;
  }> = [];

  let searchedMessageCount = 0;
  let foldedMessageCount = 0;
  messages.forEach((message, index) => {
    const folded = isFolded(index);
    if (folded) foldedMessageCount += 1;
    if (!parsed.includeFolded && folded) return;
    if (parsed.role !== "any" && message.info.role !== parsed.role) return;
    const rendered = renderStoredMessage(message);
    if (rendered.text.trim().length === 0) return;
    searchedMessageCount += 1;
    const score = scoreMessage(rendered, query, terms);
    if (score <= 0) return;
    scored.push({
      createdAt: rendered.createdAt,
      folded,
      messageId: rendered.messageId,
      role: rendered.role,
      score,
      snippet: buildSnippet(rendered, query, terms),
    });
  });

  scored.sort((left, right) => right.score - left.score || right.createdAt - left.createdAt);
  const selected: typeof scored = [];
  let usedChars = 0;
  let truncated = false;
  for (const match of scored.slice(0, parsed.maxResults)) {
    if (usedChars + match.snippet.length > budget) {
      truncated = true;
      break;
    }
    selected.push(match);
    usedChars += match.snippet.length;
  }

  return {
    foldedMessageCount,
    matches: selected.map((match) => ({
      createdAt: match.createdAt,
      folded: match.folded,
      messageId: match.messageId,
      role: match.role,
      score: match.score,
      snippet: match.snippet,
    })),
    query: parsed.query,
    searchedMessageCount,
    sessionId: context.sessionId,
    status: selected.length > 0 ? "success" : "not_found",
    truncated: truncated || scored.length > selected.length,
  } satisfies SearchContextOutput;
};

export const searchContextToolEntry: ToolEntry = {
  capability: "Search the durable session transcript, including history folded away by compaction",
  metadata: {
    // 桌面宿主只把 deferred 类 ZCode 工具经 ToolSearch 暴露给模型；不标记的话
    // 这个工具既不在直连函数面、也不在延迟目录，模型根本调不到（与 ReadSessionContext 同口径）。
    shouldDefer: true,
    name: SEARCH_CONTEXT_TOOL_NAME,
    description:
      "Keyword-search the full persisted transcript of the current session, including messages that compaction already folded away.",
    modelInstructions: [
      "Use this before claiming something is unknowable after a compaction, and when the summary mentions a decision but you need the original wording, path, command, or error text.",
      "Prefer narrow keywords over whole sentences. Set includeFolded=false to search only the visible context.",
      "Results are excerpts with persisted message ids; fetch a whole folded range with DecompressContext when the excerpt is not enough.",
    ],
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: searchContextHandler,
  formatModelContent: (output) => formatSearchContext(SearchContextOutputSchema.parse(output)),
  inputSchema: SearchContextInputJsonSchema,
  outputSchema: SearchContextOutputJsonSchema,
  runtimeInputSchema: SearchContextInputSchema,
  runtimeOutputSchema: SearchContextOutputSchema,
  permission: {
    permission: "session.context.read",
    reason: "Search the current session transcript",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_MODEL_BYTES,
    maxModelBytes: MAX_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TIMEOUT_MS, maxMs: TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "SearchContext was cancelled",
  },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

function formatSearchContext(output: SearchContextOutput): string {
  if (output.status === "failed") {
    return `SearchContext failed: ${output.error ?? "unknown error"}`;
  }
  if (output.status === "not_found") {
    return `No match for "${output.query}" in ${output.searchedMessageCount} messages (${output.foldedMessageCount} are folded history).`;
  }
  const lines = [
    `SearchContext "${output.query}" — ${output.matches.length} match(es) of ${output.searchedMessageCount} searched messages; ${output.foldedMessageCount} folded message(s) exist.`,
  ];
  output.matches.forEach((match, index) => {
    const when = new Date(match.createdAt).toISOString();
    lines.push(
      "",
      `[${index + 1}] ${match.messageId} ${match.role} ${when}${match.folded ? " (folded)" : ""} score=${match.score}`,
      clip(match.snippet, 1200),
    );
  });
  if (output.truncated) lines.push("", "… results truncated; narrow the query or raise maxResults.");
  return lines.join("\n");
}
