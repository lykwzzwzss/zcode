import {
  CONTEXT_MEMORY_DEFAULT_MAX_CHARS,
  CoreErrorType,
  DECOMPRESS_CONTEXT_TOOL_NAME,
  DecompressContextInputJsonSchema,
  DecompressContextInputSchema,
  DecompressContextOutputJsonSchema,
  DecompressContextOutputSchema,
  createCoreError,
  type DecompressContextOutput,
  type MessageWithParts,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  clip,
  collectCompactedRanges,
  foldedWindowForRange,
  renderStoredMessage,
} from "./context-memory-store.js";

const MAX_MODEL_BYTES = 120_000;
const TIMEOUT_MS = 30_000;

/**
 * 把一段被折叠的历史原样放回上下文。
 * 落地方式是工具结果：结果会作为消息持久化，后续轮次仍然可见——语义上等价于
 * 「解压进历史」，但不需要 Runtime 干预历史数组，也不会打断当前 turn 的缓存布局。
 */
export const decompressContextHandler: ToolHandler = async (input, context) => {
  const parsed = DecompressContextInputSchema.parse(input);
  if (!context.sessionStore) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "SessionStorePort is not configured for DecompressContext",
      { context: { toolName: DECOMPRESS_CONTEXT_TOOL_NAME }, recoverable: false },
    );
  }

  const budget = parsed.maxChars ?? CONTEXT_MEMORY_DEFAULT_MAX_CHARS;
  let messages: MessageWithParts[];
  try {
    messages = await context.sessionStore.messages({ sessionID: context.sessionId });
  } catch (error) {
    // 读库失败按工具结果返回，和 ReadSessionContext 一致：配置缺失才抛。
    if (context.abortSignal.aborted) throw error;
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: `DecompressContext could not read the session transcript: ${message}`,
      error: message,
      messageCount: 0,
      ranges: [],
      sessionId: context.sessionId,
      status: "failed",
      truncated: false,
    } satisfies DecompressContextOutput;
  }
  const ranges = collectCompactedRanges(messages);
  const rangeOutputs = ranges.map((range) => ({
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
  }));

  const base = {
    messageCount: 0,
    ranges: rangeOutputs,
    sessionId: context.sessionId,
    status: "not_found" as const,
    truncated: false,
  };

  if (parsed.messageIds && parsed.messageIds.length > 0) {
    const wanted = new Set(parsed.messageIds);
    const picked = messages
      .filter((message) => wanted.has(message.info.id))
      .map((message) => renderStoredMessage(message))
      .filter((rendered) => rendered.text.trim().length > 0);
    if (picked.length === 0) {
      return { ...base, content: "None of the requested message ids exist in this session." };
    }
    const fitted = fitFromEnd(picked, budget);
    return {
      ...base,
      boundaryId: parsed.boundaryId,
      content: renderTranscriptBlocks(fitted.rendered),
      messageCount: fitted.rendered.length,
      status: "success",
      truncated: fitted.truncated,
    } satisfies DecompressContextOutput;
  }

  const range = parsed.boundaryId
    ? ranges.find((item) => item.boundaryId === parsed.boundaryId)
    : ranges.at(-1);
  if (!range) {
    return {
      ...base,
      content:
        ranges.length === 0
          ? "This session has no compaction boundary; nothing was folded away."
          : `No compaction boundary with id ${parsed.boundaryId}.`,
    };
  }

  const window = foldedWindowForRange(ranges, range);
  const picked = messages
    .slice(window.start, window.end)
    .map((message) => renderStoredMessage(message))
    .filter((rendered) => rendered.text.trim().length > 0);
  if (picked.length === 0) {
    return {
      ...base,
      boundaryId: range.boundaryId,
      content: "The selected compaction range has no readable message text.",
    };
  }

  const fitted = fitFromEnd(picked, budget);
  return {
    ...base,
    boundaryId: range.boundaryId,
    content: renderTranscriptBlocks(fitted.rendered),
    messageCount: fitted.rendered.length,
    status: "success",
    truncated: fitted.truncated,
  } satisfies DecompressContextOutput;
};

export const decompressContextToolEntry: ToolEntry = {
  capability: "Restore the original messages of a compacted range into the conversation",
  metadata: {
    // 与 SearchContext 同口径：deferred 才能被桌面宿主的 ToolSearch 暴露给模型。
    shouldDefer: true,
    name: DECOMPRESS_CONTEXT_TOOL_NAME,
    description:
      "Restore the original text of a compaction range (or explicit message ids) from the durable transcript.",
    modelInstructions: [
      "Call CompactStatus first when you do not know the boundary id; omit boundaryId to restore the most recent range.",
      "Restored text is durable: it becomes part of the conversation, so restore only the range you actually need.",
      "Prefer SearchContext to locate a needle, then DecompressContext for the surrounding range.",
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
  handler: decompressContextHandler,
  formatModelContent: (output) =>
    formatDecompressContext(DecompressContextOutputSchema.parse(output)),
  inputSchema: DecompressContextInputJsonSchema,
  outputSchema: DecompressContextOutputJsonSchema,
  runtimeInputSchema: DecompressContextInputSchema,
  runtimeOutputSchema: DecompressContextOutputSchema,
  permission: {
    permission: "session.context.read",
    reason: "Restore folded transcript text of the current session",
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
    userVisibleMessage: "DecompressContext was cancelled",
  },
  trace: { required: true, propagateToAdapters: true, recordInput: "summary", recordOutput: "summary" },
};

interface RenderedPick {
  messageId: string;
  role: "user" | "assistant";
  createdAt: number;
  text: string;
}

function fitFromEnd(
  rendered: readonly RenderedPick[],
  budget: number,
): { rendered: RenderedPick[]; truncated: boolean } {
  // 折叠区间很长时优先保留靠近边界的尾部：那一段通常与当前工作最相关。
  const picked: RenderedPick[] = [];
  let used = 0;
  let truncated = false;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const item = rendered[index]!;
    if (used + item.text.length > budget) {
      truncated = true;
      break;
    }
    picked.push(item);
    used += item.text.length;
  }
  picked.reverse();
  return { rendered: picked, truncated };
}

function renderTranscriptBlocks(rendered: readonly RenderedPick[]): string {
  return rendered
    .map((item) => {
      const when = new Date(item.createdAt).toISOString();
      return `### ${item.messageId} · ${item.role} · ${when}\n${clip(item.text, 20_000)}`;
    })
    .join("\n\n");
}

function formatDecompressContext(output: DecompressContextOutput): string {
  if (output.status === "not_found") return output.content;
  const header = `Restored ${output.messageCount} message(s)${output.boundaryId ? ` from ${output.boundaryId}` : ""}${output.truncated ? " (truncated)" : ""}.`;
  return `${header}\n\n${output.content}`;
}
