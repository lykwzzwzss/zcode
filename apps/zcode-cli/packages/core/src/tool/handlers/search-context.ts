import {
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
import { requireContextArchiveSuccess } from "../../native-context/tool-errors.js";
const MAX_MODEL_BYTES = 80_000;
const TIMEOUT_MS = 30_000;
export const searchContextHandler: ToolHandler = async (input, context) => {
  const parsed = SearchContextInputSchema.parse(input),
    archive = context.sessionStore?.contextArchive;
  // 原文只走有界存储端口，缺失能力不能悄悄回退整条会话扫描。
  if (!archive)
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ContextArchivePort is not configured for SearchContext",
      { context: { toolName: SEARCH_CONTEXT_TOOL_NAME }, recoverable: false },
    );
  // 原始存储/取消异常直接交给 executor；不在 handler 中降级为普通 output。
  return requireContextArchiveSuccess(
    await archive.search({
      ...parsed,
      sessionId: context.sessionId,
      signal: context.abortSignal,
    }),
    SEARCH_CONTEXT_TOOL_NAME,
  );
};

export const searchContextToolEntry: ToolEntry = {
  capability: "Search the durable session transcript, including history folded away by compaction",
  metadata: {
    // 常驻直连：system prompt 的 Context management 段直接点名这四个工具，
    // 再走延迟目录就会出现「提示让调、函数面里没有」的错位（bili 也是常驻）。
    alwaysLoad: true,
    name: SEARCH_CONTEXT_TOOL_NAME,
    description:
      "Keyword-search the full persisted transcript of the current session, including messages that compaction already folded away and the compaction summaries themselves.",
    modelInstructions: [
      "Use this before claiming something is unknowable after a compaction, and when the summary mentions a decision but you need the original wording, path, command, or error text.",
      'Prefer narrow keywords over whole sentences. Set includeFolded=false to search only the visible context. Set scope to "messages" or "summaries" to search one side only; the default searches both.',
      'Summary matches (kind:"summary") carry boundaryId — pass it to DecompressContext with tier:"original" to read the original messages behind that summary. Matches with retained:true are older retained summaries that have no boundary of their own.',
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
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
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
    // 摘要命中要看起来「可行动」：标出 kind、boundaryId 与 retained，
    // 模型才知道下一步该把哪个 id 交给 DecompressContext。
    const tags = [
      match.kind === "summary" ? "summary" : "",
      match.folded ? "folded" : "",
      match.retained ? "retained: no boundary" : "",
    ].filter((tag) => tag.length > 0);
    const qualifiers = tags.length > 0 ? ` (${tags.join(", ")})` : "";
    const boundary = match.boundaryId ? ` boundaryId=${match.boundaryId}` : "";
    // snippet 在产出时已按摘要/消息各自的上限截好（摘要约 1600 字符、消息约 440 字符），
    // 这里直接展示，不再二次裁剪。
    lines.push(
      "",
      `[${index + 1}] ${match.messageId} ${match.role} ${when}${qualifiers}${boundary} score=${match.score}`,
      match.snippet,
    );
  });
  if (output.nextCursor)
    lines.push("", `Continue with the same query and filters, cursor=${output.nextCursor}`);
  else if (output.truncated)
    lines.push("", "… results truncated; narrow the query or raise maxResults.");
  return lines.join("\n");
}
