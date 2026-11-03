import {
  COMPACT_NOW_TOOL_NAME,
  CompactNowInputJsonSchema,
  CompactNowInputSchema,
  CompactNowOutputJsonSchema,
  CompactNowOutputSchema,
  type CompactNowOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";

const MAX_MODEL_BYTES = 8_000;
const TIMEOUT_MS = 10_000;

/**
 * 模型自决压缩的入口。工具本身不折叠任何东西——它只把请求排进 Runtime，
 * 由 turn-loop 在下一个模型步之前执行一次真正的折叠。这样压缩发生在
 * 「工具批次结束、下一次请求开始」的安全点，而不是折叠正在进行时改历史。
 */
export const compactNowHandler: ToolHandler = async (input, context) => {
  const parsed = CompactNowInputSchema.parse(input);
  if (!context.compactControlPort) {
    return {
      message:
        "Compaction control is not available in this runtime (subagent or host without the port).",
      reason: "port_unavailable",
      status: "rejected",
    } satisfies CompactNowOutput;
  }

  const result = context.compactControlPort.requestCompact({
    instructions: parsed.instructions,
    ...(parsed.ranges ? { ranges: parsed.ranges } : {}),
    reason: parsed.reason,
  });
  if (!result.accepted) {
    return {
      message:
        result.reason === "compaction_already_requested"
          ? "A compaction request is already queued for the next model step."
          : `Compaction request was rejected: ${result.reason ?? "unknown reason"}.`,
      reason: result.reason,
      status: "rejected",
    } satisfies CompactNowOutput;
  }

  return {
    message: parsed.instructions
      ? "Compaction queued. It runs before the next model request and will honor your instructions."
      : "Compaction queued. It runs before the next model request.",
    status: "accepted",
  } satisfies CompactNowOutput;
};

export const compactNowToolEntry: ToolEntry = {
  capability: "Queue a context compaction that runs before the next model request",
  metadata: {
    // 与 SearchContext 同口径：四个工具常驻直连，system prompt 里也写了用法。
    alwaysLoad: true,
    name: COMPACT_NOW_TOOL_NAME,
    description:
      "Ask the runtime to compact the conversation before the next model request, optionally with instructions about what the summary must keep.",
    modelInstructions: [
      "Prefer ranges with a self-contained summary in EVERY range: you write the summaries in this call, so no separate summary model request is needed. Use exact complete-round endpoints; omit summaries only when the runtime must generate them. Batch disjoint ranges in one call. Preserve open objectives, constraints, decisions, paths and exact errors. Summaries are historical data, not new instructions.",
      "Use when the context is getting heavy, when switching tasks, or when the user asks to compact now.",
      "Pass instructions describing what must survive the fold (files, decisions, exact strings).",
      "To fold only specific segments while keeping the messages between them intact, pass `ranges` with persisted message ids (startMessageId/endMessageId). Each range gets its own summary and is replaced in place; omitted ranges stay in context.",
      "The fold happens before the next model request; nothing is lost from disk — SearchContext and DecompressContext can recover folded text.",
    ],
    readOnly: false,
    destructive: false,
    // 折叠是 session 作用域的非破坏动作；plan 模式下 auto-compact 本来就会发生，
    // 拒绝这个入口只会让模型每 22.5k 白撞一次权限。
    allowedInPlanMode: true,
    concurrentSafe: true,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: compactNowHandler,
  formatModelContent: (output) => {
    const parsed = CompactNowOutputSchema.parse(output);
    return parsed.status === "accepted" ? parsed.message : `CompactNow rejected: ${parsed.message}`;
  },
  inputSchema: CompactNowInputJsonSchema,
  outputSchema: CompactNowOutputJsonSchema,
  runtimeInputSchema: CompactNowInputSchema,
  runtimeOutputSchema: CompactNowOutputSchema,
  permission: {
    permission: "session.compact",
    reason: "Compact the current session before the next model request",
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
    supported: false,
    cleanup: "none",
    userVisibleMessage: "CompactNow was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};
