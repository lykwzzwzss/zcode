import {
  COMPACT_STATUS_TOOL_NAME,
  CompactStatusInputJsonSchema,
  CompactStatusInputSchema,
  CompactStatusOutputJsonSchema,
  CompactStatusOutputSchema,
  CoreErrorType,
  createCoreError,
  selectActiveConversationBranch,
  type CompactStatusOutput,
  type MessageWithParts,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import { collectCompactedRanges, collectFoldedMessageIndexes } from "./context-memory-store.js";

const MAX_MODEL_BYTES = 40_000;
const TIMEOUT_MS = 20_000;

export const compactStatusHandler: ToolHandler = async (input, context) => {
  CompactStatusInputSchema.parse(input);
  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for CompactStatus",
      { context: { toolName: COMPACT_STATUS_TOOL_NAME }, recoverable: false },
    );
  }

  let messages: MessageWithParts[];
  let branchMessages: MessageWithParts[];
  try {
    messages = await context.sessionStore.messages({ sessionID: context.sessionId });
    const session = await context.sessionStore.getSession(context.sessionId);
    // 只统计当前分支：rewind 掉的旧分支还在 append-only store 里，不能算进来。
    branchMessages = selectActiveConversationBranch(messages, {
      branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session?.revert?.createdMessageID,
      rewindKeptMessageIds: session?.revert?.keptMessageIDs,
      rewindTargetMessageId: session?.revert?.targetMessageID,
    });
  } catch (error) {
    if (context.abortSignal.aborted) throw error;
    return {
      activeMessageCount: 0,
      error: error instanceof Error ? error.message : String(error),
      foldedMessageCount: 0,
      messageCount: 0,
      ranges: [],
      sessionId: context.sessionId,
      status: "failed",
    } satisfies CompactStatusOutput;
  }
  const ranges = collectCompactedRanges(branchMessages);
  const last = ranges.at(-1);
  const foldedIndexes = collectFoldedMessageIndexes(branchMessages, ranges);

  return {
    activeMessageCount: branchMessages.length - foldedIndexes.size,
    foldedMessageCount: foldedIndexes.size,
    lastCompactAt: last?.createdAt,
    messageCount: branchMessages.length,
    ranges: ranges.map((range) => ({
      boundaryId: range.boundaryId,
      createdAt: range.createdAt,
      lastSummarizedMessageId: range.lastSummarizedMessageId,
      messageId: range.messageId,
      phase: range.phase,
      postCompactTokenCount: range.postCompactTokenCount,
      preCompactTokenCount: range.preCompactTokenCount,
      summarizedMessageCount: range.summarizedMessageCount,
      summaryMessageId: range.summaryMessageId,
      trigger: range.trigger,
    })),
    sessionId: context.sessionId,
    status: "success",
  } satisfies CompactStatusOutput;
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
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

function formatCompactStatus(output: CompactStatusOutput): string {
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
  lines.push("", "Compaction ranges (oldest first):");
  output.ranges.forEach((range, index) => {
    lines.push(
      `${index + 1}. ${range.boundaryId} · ${new Date(range.createdAt).toISOString()} · ${range.summarizedMessageCount} msg · ${range.preCompactTokenCount ?? "?"}→${range.postCompactTokenCount ?? "?"} tok${range.trigger ? ` · ${range.trigger}` : ""}`,
    );
  });
  return lines.join("\n");
}
