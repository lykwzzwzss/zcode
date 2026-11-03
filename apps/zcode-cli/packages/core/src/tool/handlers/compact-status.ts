import {
  COMPACT_STATUS_TOOL_NAME,
  CompactStatusInputJsonSchema,
  CompactStatusInputSchema,
  CompactStatusOutputJsonSchema,
  CompactStatusOutputSchema,
  CoreErrorType,
  createCoreError,
  type CompactCacheUsage,
  type CompactStatusOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { requireContextArchiveSuccess } from "../../native-context/tool-errors.js";
const MAX_MODEL_BYTES = 40_000;
const TIMEOUT_MS = 20_000;
export const compactStatusHandler: ToolHandler = async (input, context) => {
  const parsed = CompactStatusInputSchema.parse(input),
    archive = context.sessionStore?.contextArchive;
  if (!archive)
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ContextArchivePort is not configured for CompactStatus",
      { context: { toolName: COMPACT_STATUS_TOOL_NAME }, recoverable: false },
    );
  // 原始存储/取消异常直接交给 executor；不伪造全零计数的成功调用。
  return requireContextArchiveSuccess(
    await archive.status({
      ...parsed,
      sessionId: context.sessionId,
      signal: context.abortSignal,
    }),
    COMPACT_STATUS_TOOL_NAME,
  );
};

export const compactStatusToolEntry: ToolEntry = {
  capability: "Report how much durable history exists and which ranges compaction folded away",
  metadata: {
    // 与 SearchContext 同口径：四个工具常驻直连，system prompt 里也写了用法。
    alwaysLoad: true,
    name: COMPACT_STATUS_TOOL_NAME,
    description:
      "Report persisted message counts and every compaction boundary (what was folded, when, how much).",
    modelInstructions: [
      "Use when you need the boundary id for DecompressContext, or before deciding whether to compact now.",
      "foldedMessageCount counts messages that are only reachable through SearchContext/DecompressContext.",
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
  handler: compactStatusHandler,
  formatModelContent: (output) => formatCompactStatus(CompactStatusOutputSchema.parse(output)),
  inputSchema: CompactStatusInputJsonSchema,
  outputSchema: CompactStatusOutputJsonSchema,
  runtimeInputSchema: CompactStatusInputSchema,
  runtimeOutputSchema: CompactStatusOutputSchema,
  permission: {
    permission: "session.context.read",
    reason: "Read compaction state of the current session",
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
    userVisibleMessage: "CompactStatus was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatCompactStatus(output: CompactStatusOutput): string {
  // 保留历史失败输出的格式化能力；新调用的失败统一进入 executor 错误路径。
  if (output.status === "failed") {
    const failedLines = [`Session ${output.sessionId}: compaction state unavailable.`];
    if (output.error) failedLines.push(`Error: ${output.error}`);
    return failedLines.join("\n");
  }
  const lines = [
    `Session ${output.sessionId}: ${output.messageCount} persisted message(s), ${output.activeMessageCount} active, ${output.foldedMessageCount} folded.`,
  ];
  if (output.lastCompactAt !== undefined) {
    lines.push(`Last compaction: ${new Date(output.lastCompactAt).toISOString()}`);
  }
  if (output.ranges.length === 0) {
    lines.push("No compaction boundary yet — nothing has been folded away.");
    return lines.join("\n");
  }
  lines.push("", "Compaction ranges:");
  output.ranges.forEach((range, index) => {
    lines.push(
      `${index + 1}. ${range.boundaryId} · ${new Date(range.createdAt).toISOString()} · ${range.summarizedMessageCount} msg · ${range.preCompactTokenCount ?? "?"}→${range.postCompactTokenCount ?? "?"} tok${range.trigger ? ` · ${range.trigger}` : ""}`,
    );
    if (range.level !== undefined)
      lines.push(
        `   level=${range.level} originals=${range.originalMessageCount ?? "?"} children=${range.childBoundaryIds?.join(",") || "none"}${(range.childBoundaryCount ?? 0) > (range.childBoundaryIds?.length ?? 0) ? " (use CompactStatus boundaryId to page children)" : ""}`,
      );
  });
  lines.push("", formatFoldCost(output.ranges));
  if (output.nextCursor)
    lines.push(`Continue CompactStatus with the same boundaryId and cursor=${output.nextCursor}`);
  return lines.join("\n");
}

const FOLD_COST_DIMENSIONS = [
  { key: "inputTokens", label: "input" },
  { key: "cacheReadTokens", label: "cache read" },
  { key: "cacheWriteTokens", label: "cache write" },
] as const satisfies readonly { key: keyof CompactCacheUsage; label: string }[];

function formatFoldCost(ranges: CompactStatusOutput["ranges"]): string {
  const total = (key: keyof CompactCacheUsage): number | undefined => {
    const values = ranges.flatMap((range) => {
      const value = range.cacheUsage?.[key];
      return value === undefined ? [] : [value];
    });
    return values.length === 0 ? undefined : values.reduce((sum, value) => sum + value, 0);
  };
  // 按维度各自统计上报个数：某个 boundary 只报了 input 时，cache read 的合计不能
  // 拿其余 boundary 的数据冒充完整；分母写维度自己的，缺失维度直接 unavailable。
  const segments = FOLD_COST_DIMENSIONS.map((dimension) => {
    const reportedFolds = ranges.filter(
      (range) => range.cacheUsage?.[dimension.key] !== undefined,
    ).length;
    if (reportedFolds === 0) return `${dimension.label} unavailable`;
    const coverage =
      reportedFolds < ranges.length ? ` (${reportedFolds}/${ranges.length} folds)` : "";
    return `${dimension.label} ${formatFoldCostTokens(total(dimension.key))}${coverage}`;
  });
  if (segments.every((segment) => segment.endsWith("unavailable"))) {
    // 旧 boundary 或 provider 未上报 usage：明确说「没有数据」，不能画成 0 命中。
    return "cache usage unavailable";
  }
  return `fold cost: ${segments.join(" · ")}`;
}

function formatFoldCostTokens(tokens: number | undefined): string {
  if (tokens === undefined) return "unavailable";
  if (tokens < 1_000) return String(tokens);
  return `${(tokens / 1_000).toFixed(1).replace(/\.0$/u, "")}k`;
}
