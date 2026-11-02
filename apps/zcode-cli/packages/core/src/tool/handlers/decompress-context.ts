import {
  CoreErrorType,
  DECOMPRESS_CONTEXT_TOOL_NAME,
  DecompressContextInputJsonSchema,
  DecompressContextInputSchema,
  DecompressContextOutputJsonSchema,
  DecompressContextOutputSchema,
  createCoreError,
  selectActiveConversationBranch,
  type DecompressContextOutput,
  type MessageWithParts,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  clip,
  collectCompactedRanges,
  foldedWindowForRange,
  keptMessageIdsForRange,
  renderStoredMessage,
  type RenderedMessage,
} from "./context-memory-store.js";

const MAX_MODEL_BYTES = 120_000;
// 解压是「取回原文」，工具输出不能再按检索用的 1200 字符截；单条最多 20k。
const DECOMPRESS_TOOL_OUTPUT_MAX = 20_000;
const DECOMPRESS_MESSAGE_MAX = 20_000;
// 搜索默认 20k 是给 snippet 用的；解压沿用 20k 会在第一条大输出就装满，
// 改成 60k 才能一次取回多轮原文（schema 上限仍是 80k）。
const DECOMPRESS_DEFAULT_MAX_CHARS = 60_000;
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

  const budget = parsed.maxChars ?? DECOMPRESS_DEFAULT_MAX_CHARS;
  let messages: MessageWithParts[];
  let branchMessages: MessageWithParts[];
  try {
    messages = await context.sessionStore.messages({ sessionID: context.sessionId });
    const session = await context.sessionStore.getSession(context.sessionId);
    // rewind 掉的旧分支仍在库里；解压不能把用户刚撤销的区间重新搬回上下文。
    branchMessages = selectActiveConversationBranch(messages, {
      branchCutAfterMessageId: session?.revert?.branchCutAfterMessageID,
      rewindCreatedMessageId: session?.revert?.createdMessageID,
      rewindKeptMessageIds: session?.revert?.keptMessageIDs,
      rewindTargetMessageId: session?.revert?.targetMessageID,
    });
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
  const ranges = collectCompactedRanges(branchMessages);
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
    const picked = branchMessages
      .filter((message) => wanted.has(message.info.id))
      .map((message) =>
        toPick(
          renderStoredMessage(message, { toolOutputMaxChars: DECOMPRESS_TOOL_OUTPUT_MAX }),
        ),
      )
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
  // 是否仍活跃以「最后一个 boundary」为准：早期 boundary 声明保留、后来被 4 层上限
  // 裁掉的摘要层，SearchContext 已标 folded，这里也必须能解压出来。
  const activeBoundary = ranges.at(-1);
  const kept = activeBoundary
    ? keptMessageIdsForRange(branchMessages, activeBoundary)
    : new Set<string>();
  const picked = branchMessages
    .slice(window.start, window.end)
    .filter((message) => !kept.has(message.info.id))
    .map((message) =>
      toPick(renderStoredMessage(message, { toolOutputMaxChars: DECOMPRESS_TOOL_OUTPUT_MAX })),
    )
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
    // 与 SearchContext 同口径：四个工具常驻直连，system prompt 里也写了用法。
    alwaysLoad: true,
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
  truncated?: boolean;
}

function toPick(rendered: RenderedMessage): RenderedPick {
  const text = clip(rendered.text, DECOMPRESS_MESSAGE_MAX);
  return {
    ...rendered,
    text,
    truncated: rendered.truncated === true || text.length !== rendered.text.length,
  };
}

// 工具层按字节截断（maxModelBytes），预算按字符；CJK 下两者差三倍，
// 这里同时卡字符与字节，避免工具自报 truncated=false 却被序列化层砍掉。
const OUTPUT_BYTE_CAP = MAX_MODEL_BYTES - 4_000;
const UTF8 = new TextEncoder();

function utf8Bytes(text: string): number {
  return UTF8.encode(text).length;
}

function fitFromEnd(
  rendered: readonly RenderedPick[],
  budget: number,
): { rendered: RenderedPick[]; truncated: boolean } {
  // 折叠区间很长时优先保留靠近边界的尾部：那一段通常与当前工作最相关。
  const picked: RenderedPick[] = [];
  let usedChars = 0;
  let usedBytes = 0;
  let truncated = false;
  for (let index = rendered.length - 1; index >= 0; index -= 1) {
    const item = rendered[index]!;
    const bytes = utf8Bytes(item.text);
    if (usedChars + item.text.length > budget || usedBytes + bytes > OUTPUT_BYTE_CAP) {
      truncated = true;
      break;
    }
    picked.push(item);
    usedChars += item.text.length;
    usedBytes += bytes;
  }
  picked.reverse();
  // 单条消息本身就超过预算时，上面的循环会在第一条直接 break。返回裁剪版，
  // 否则调用方看到的是「Restored 0 message(s)」——消息明明存在，却一个字都没取回。
  if (picked.length === 0 && rendered.length > 0) {
    const last = rendered[rendered.length - 1]!;
    let text = clip(last.text, Math.max(1, budget));
    const bytes = utf8Bytes(text);
    if (bytes > OUTPUT_BYTE_CAP) {
      text = clip(text, Math.max(1, Math.floor((text.length * OUTPUT_BYTE_CAP) / bytes) - 1));
    }
    picked.push({ ...last, text, truncated: true });
    truncated = true;
  }
  return {
    rendered: picked,
    truncated: truncated || picked.some((item) => item.truncated === true),
  };
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
  if (output.status === "failed") {
    return `DecompressContext failed: ${output.error ?? "unknown error"}`;
  }
  if (output.status === "not_found") return output.content;
  const header = `Restored ${output.messageCount} message(s)${output.boundaryId ? ` from ${output.boundaryId}` : ""}${output.truncated ? " (truncated)" : ""}.`;
  return `${header}\n\n${output.content}`;
}
