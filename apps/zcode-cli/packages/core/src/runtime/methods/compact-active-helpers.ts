import { isDeepSeekFlashModel } from "../../native-context/contract.js";
import { type ModelToolContract } from "@zcode/contracts";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { collectDiscoveredTools, compactDiscoveryMetadata } from "../../tool/search/history.js";
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import { createCompactBoundaryId } from "../deps.js";
import {
  throwIfTurnAborted,
  readApprovedPlanFileReferenceEntry,
  restorePostCompactFiles,
  buildRuntimeModeReminderBody,
  hasFullRuntimeModeReminder,
} from "../helpers/index.js";
import {
  buildCompactLeadingAnnouncements,
  collectSkillsListing,
  resolveSessionContextAnnouncement,
  restateContextAfterCompact,
} from "./context-refresh.js";
import type { Model } from "../deps.js";
import { systemReminderAttachmentEntry } from "../../agent/message-history.js";
import {
  COMPACT_PROMPT_TOO_LONG_USER_MESSAGE,
  CompactTimelineStatus,
  CompactTrigger,
  SessionEventType,
  CoreErrorType,
  createCoreError,
  formatCompactSummary,
  modelMessageContentToText,
  traceContextToLogContext,
} from "../deps.js";
import type { CompactTimelinePayload, MessageId, SessionEvent, TraceContext } from "../deps.js";
import {
  buildProviderRequestMessages,
  createModelContextExceededFinishError,
  isContextExceededFinishReason,
  readRawFinishReason,
} from "../helpers/index.js";
import type {
  CompactTimelineContext,
  RuntimeModelTextResult,
  RunModelTextRequestOptions,
} from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import type { ReadFileStateEntry } from "../../tool/types.js";
import { replaceReadFileStateAfterCompact } from "../helpers/compact-post-reminders.js";
import { resetProjectMemoryRecall } from "../helpers/project-memory-recall.js";
import {
  filterOutputTokenContinuationEntries,
  preserveCanonicalContextPrefix,
} from "./turn-output-token-continuation.js";

export const COMPACT_TOOL_USE_DENIAL_MESSAGE = "Tool use is not allowed during compaction";
export const COMPACT_TOOL_USE_DENIAL_REASON = "compaction agent should only produce text summary";

/** 健康 no-op 只有时间线终态，不产生摘要、边界或活跃历史写入。 */
export async function finishSkippedCompact(
  runtime: AgentRuntimeInternal,
  timeline: CompactTimelineContext & { preCompactTokenCount: number },
  entries: readonly RuntimeMessageEntry[],
  traceContext: TraceContext,
  events: SessionEvent[],
  displayText: string,
  reason?: string,
) {
  await persistCompactTimelineEvent(
    runtime,
    SessionEventType.CompactCompleted,
    runtime.buildCompactTimelinePayload(timeline, {
      endedAt: Date.now(),
      replace: true,
      status: CompactTimelineStatus.Skipped,
      ...(reason ? { reason } : {}),
    }),
    traceContext,
    events,
  );
  return {
    displayText,
    entries,
    outcome: "skipped" as const,
    tokenCount: timeline.preCompactTokenCount,
  };
}

/** 摘要成本已发生也不能为凑成功记录而提交更大的上下文；必要恢复无法缩小时必须停止。 */
export async function skipNonShrinkingCompact(
  runtime: AgentRuntimeInternal,
  input: {
    timeline: CompactTimelineContext & { preCompactTokenCount: number };
    entries: readonly RuntimeMessageEntry[];
    postTokens: number;
    model: { modelId: string };
    force?: boolean;
    autoCompactThreshold?: number;
    abortSignal?: AbortSignal;
    traceContext: TraceContext;
    events: SessionEvent[];
  },
) {
  if (
    input.postTokens < input.timeline.preCompactTokenCount ||
    (!input.force && !isDeepSeekFlashModel(input.model))
  )
    return undefined;
  throwIfTurnAborted(input.abortSignal);
  if (
    input.timeline.trigger === CompactTrigger.Reactive ||
    (input.timeline.trigger === CompactTrigger.Auto && input.autoCompactThreshold !== undefined)
  ) {
    throw createCoreError(
      CoreErrorType.ModelContextExceeded,
      "Compaction cannot reduce context enough to continue. Start a new session or reduce the active context.",
      {
        context: {
          reason: "no_net_shrink",
          preCompactTokens: input.timeline.preCompactTokenCount,
          postCompactTokens: input.postTokens,
        },
        recoverable: true,
        retryable: false,
      },
    );
  }
  return finishSkippedCompact(
    runtime,
    input.timeline,
    input.entries,
    input.traceContext,
    input.events,
    "Compaction skipped: summaries and reminders do not reduce context. Original history and prefix cache are unchanged.",
    "no_net_shrink",
  );
}

export interface CommittedCompactState {
  entries: readonly RuntimeMessageEntry[];
  preserveCanonicalPrefix: boolean;
  readFileStateEntries: readonly ReadFileStateEntry[];
  summaryMessageId: MessageId;
  tokenCount: number;
}

/** 摘要 bundle 提交后同步应用状态；这里不得 await，事件失败也不能留下旧的活跃历史。 */
export function applyCommittedCompactState(
  runtime: AgentRuntimeInternal,
  input: CommittedCompactState,
): void {
  const recordable = filterOutputTokenContinuationEntries(input.entries);
  runtime.messageHistory.replaceMessages(
    input.preserveCanonicalPrefix
      ? preserveCanonicalContextPrefix(
          runtime.messageHistory.borrowReadOnlyRuntimeEntries(),
          recordable,
        )
      : recordable,
  );
  runtime.latestConversationMessageId = input.summaryMessageId;
  replaceReadFileStateAfterCompact(runtime.readFileState, input.readFileStateEntries);
  resetProjectMemoryRecall(runtime);
  runtime.lastCompactNudgeTokenCount = input.tokenCount;
  // 成功应用已提交摘要才解除失败熔断；手动、自动和重放共用同一个成功边界。
  runtime.autoCompactConsecutiveFailures = 0;
}

/**
 * 已落盘的提交必须在下一次请求前应用到活跃历史。提交点先登记重放输入，直到后续事件、
 * 时间线和钩子全部成功才清除（见 finalizeCommittedCompactApply）；任何一步失败都会留下
 * 重放输入，原始错误仍向上抛出，下一次请求入口会重放，绝不继续使用旧历史。
 */
export function applyOrDeferCommittedCompactState(
  runtime: AgentRuntimeInternal,
  input: CommittedCompactState,
): void {
  runtime.pendingCommittedCompactApply = input;
  applyCommittedCompactState(runtime, input);
}

/** 提交后的后续 I/O 与钩子全部成功，清除重放输入，避免下一次请求重复应用。 */
export function finalizeCommittedCompactApply(runtime: AgentRuntimeInternal): void {
  runtime.pendingCommittedCompactApply = undefined;
}

/** 重放未完成的提交应用；再次失败按提交状态错误抛出，不能降级为警告后继续。 */
export function recoverCommittedCompactApply(runtime: AgentRuntimeInternal): void {
  const pending = runtime.pendingCommittedCompactApply;
  if (!pending) return;
  try {
    applyCommittedCompactState(runtime, pending);
  } catch (error) {
    throw createCoreError(
      CoreErrorType.InvalidStateTransition,
      "Committed compaction state could not be applied to the active runtime",
      {
        cause: error instanceof Error ? error : undefined,
        context: { summaryMessageId: pending.summaryMessageId },
        recoverable: false,
      },
    );
  }
  runtime.pendingCommittedCompactApply = undefined;
  runtime.logger?.info?.("Recovered committed compaction state", {
    event: "compact.post_commit.recovered",
    module: "core.runtime",
    summaryMessageId: pending.summaryMessageId,
  });
}

/** 已提交操作只暴露后续错误；不得重试摘要或覆盖成 failed，resume 会按 boundary 补齐时间线。 */
export function logCommittedCompactFailure(
  runtime: AgentRuntimeInternal,
  error: unknown,
  timeline: CompactTimelineContext,
  traceContext: TraceContext,
): void {
  runtime.logger?.error(
    "Compaction committed but follow-up failed",
    error instanceof Error ? error : undefined,
    {
      ...traceContextToLogContext(traceContext),
      errorMessage: error instanceof Error ? error.message : String(error),
      event: "compact.post_commit.failed",
      module: "core.runtime",
      operationId: timeline.operationId,
      status: "failed",
    },
  );
}

export function createCompactPromptTooLongError(options: {
  attempt: number;
  cause?: unknown;
  preCompactTokenCount: number;
}): Error {
  return createCoreError(CoreErrorType.ModelContextExceeded, COMPACT_PROMPT_TOO_LONG_USER_MESSAGE, {
    cause: options.cause instanceof Error ? options.cause : undefined,
    context: {
      compactPromptTooLongAttempts: options.attempt,
      preCompactTokenCount: options.preCompactTokenCount,
    },
    recoverable: true,
    // 修复原因：compact 内部已经完成最多 3 次旧轮次截断重试；
    // 最终仍超窗时不能再被 auto compact 外层重试放大成 3x3。
    retryable: false,
  });
}

export function createCompactContextExceededFinishError(
  result: RuntimeModelTextResult,
): Error | undefined {
  const rawFinishReason = readRawFinishReason(result.providerMetadata);
  if (
    !isContextExceededFinishReason(result.finishReason, rawFinishReason) &&
    !isCompactEmptyLengthFinish(result)
  ) {
    return undefined;
  }

  return createModelContextExceededFinishError({
    finishReason: result.finishReason,
    rawFinishReason,
  });
}

function isCompactEmptyLengthFinish(result: RuntimeModelTextResult): boolean {
  // GLM/Z.AI compact 可能以 length + 空文本完成，真实含义是没有可保存的 summary；
  // 仅在 compact 路径把它归类为超窗压力，复用已有 prompt-too-long 降输入重试。
  return result.finishReason.trim().toLowerCase() === "length" && result.text.trim().length === 0;
}

export async function persistCompactTimelineEvent(
  runtime: AgentRuntimeInternal,
  type: SessionEventType,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  await runtime.persistCompactTimeline(payload, traceContext);
  const event = runtime.createEvent(type, payload, traceContext);
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}

export function buildCompactSummaryRequestMessages(
  entriesForSummary: readonly RuntimeMessageEntry[],
  compactPrompt: string,
  options: {
    useMidConversationSystem?: boolean;
    foldRemindersIntoToolResults?: boolean;
    loadedToolCallIds?: ReadonlySet<string>;
  } = {},
): RunModelTextRequestOptions["messages"] {
  return buildProviderRequestMessages({
    entries: [...entriesForSummary, { message: { role: "user" as const, content: compactPrompt } }],
    applyCacheControl: true,
    skipCacheWrite: true,
    useMidConversationSystem: options.useMidConversationSystem,
    foldRemindersIntoToolResults: options.foldRemindersIntoToolResults,
    loadedToolCallIds: options.loadedToolCallIds,
  }).messages;
}

/**
 * PreCompact 钩子的 transcript_path 内容：把待折叠条目渲染成 JSONL。
 * 宿主发起折叠必须读到原文——只给条数，钩子只能闭眼写摘要。
 * 复用模型摘要请求同一套 projection，钩子看到的就是模型本该看到的那段历史。
 */
export function renderCompactHookTranscript(
  entriesForSummary: readonly RuntimeMessageEntry[],
  options: { useMidConversationSystem?: boolean } = {},
): string {
  const messages = buildProviderRequestMessages({
    entries: entriesForSummary,
    useMidConversationSystem: options.useMidConversationSystem,
  }).messages;
  return messages
    .map((message) =>
      JSON.stringify({
        role: message.role,
        content: modelMessageContentToText(message.content),
        ...(message.toolName ? { toolName: message.toolName } : {}),
        ...(message.isError ? { isError: true } : {}),
        ...(message.toolCalls && message.toolCalls.length > 0
          ? { toolCalls: message.toolCalls.map((call) => ({ name: call.name, input: call.input })) }
          : {}),
      }),
    )
    .join("\n");
}

export function formatCompactSummaryOrThrow(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
): string {
  const compactToolCalls = runtime.extractToolCallsFromResult(result);
  if (compactToolCalls.length > 0) {
    throw createCoreError(CoreErrorType.ModelError, COMPACT_TOOL_USE_DENIAL_MESSAGE, {
      context: {
        behavior: "deny",
        decisionReason: {
          reason: COMPACT_TOOL_USE_DENIAL_REASON,
          type: "other",
        },
        toolNames: compactToolCalls.map((toolCall) => toolCall.name),
      },
      recoverable: true,
      retryable: false,
    });
  }

  const summary = formatCompactSummary(result.text);
  if (!summary) {
    throw createCoreError(CoreErrorType.ModelError, "Failed to generate compact summary", {
      recoverable: true,
      retryable: true,
    });
  }
  return summary;
}

export async function prepareCompactReminders(
  runtime: AgentRuntimeInternal,
  input: {
    options: {
      abortSignal?: AbortSignal;
      agentListingTools?: readonly { name: string }[];
    };
    activeEntries: readonly RuntimeMessageEntry[];
    preservedEntries: readonly RuntimeMessageEntry[];
    continuationModel: Model;
    continuationTools: readonly ModelToolContract[];
    registry: ReturnType<AgentRuntimeInternal["getToolRegistry"]>;
    modelTraceContext: TraceContext;
  },
) {
  const {
    options,
    activeEntries,
    preservedEntries,
    continuationModel,
    continuationTools,
    registry,
    modelTraceContext,
  } = input;
  const [planFileReferenceEntry, fileRestore] = await Promise.all([
    runtime.fileSystemPort
      ? readApprovedPlanFileReferenceEntry({
          abortSignal: options.abortSignal,
          fileSystemPort: runtime.fileSystemPort,
          sessionId: runtime.sessionId,
          traceContext: modelTraceContext,
          workspaceRoot: runtime.workspaceRoot,
        })
      : undefined,
    restorePostCompactFiles(runtime, {
      abortSignal: options.abortSignal,
      model: continuationModel,
      preservedEntries,
      traceContext: modelTraceContext,
    }),
  ]);
  // Bug 根因：compact 丢弃旧公告后曾依赖下一次请求补齐，纯 Continue 无正常收集机会。
  // 在取消检查后按保留历史重建，使用继续执行的作用域，不使用摘要候选工具。
  throwIfTurnAborted(options.abortSignal);
  const preCompactDiscoveredTools = collectDiscoveredTools(activeEntries);
  const discovery = compactDiscoveryMetadata({
    boundaryId: createCompactBoundaryId(),
    preCompactDiscoveredTools: [...preCompactDiscoveredTools],
  });
  // 新检查点尚未提交；公告使用同一候选分类，避免把即将提升的工具重新公告为待加载。
  const toolAnnouncement = buildToolSearchAnnouncement(
    {
      model: continuationModel,
      mode: runtime.config.toolSearch?.mode,
      tools: continuationTools,
      registry,
      entries: preservedEntries,
    },
    preCompactDiscoveredTools,
  );
  const agentListingEntry = collectRuntimeAgentListing(
    runtime,
    preservedEntries,
    options.agentListingTools ?? continuationTools,
  );
  const skillsListingEntry = collectSkillsListing(runtime, preservedEntries);
  // 保留段非空时，请求前公告放在 summary 之前（去掉保留段已有的来源），Git 按当前目录重读；
  // 保留段为空时由下一次请求的请求前公告追加在末尾，Git 也在那时读取。
  const leadingReminderEntries =
    preservedEntries.length > 0
      ? buildCompactLeadingAnnouncements(
          runtime,
          preservedEntries,
          await resolveSessionContextAnnouncement(
            runtime,
            preservedEntries,
            "compaction",
            modelTraceContext,
            options.abortSignal,
          ),
        )
      : [];
  // 计划模式下 compaction 重发完整的 plan 提醒。
  // 修复原因：输入附件与 auto/reactive compaction 在同一次循环中，且先于 compaction 收集；
  // 保留段可能已带本次收集的完整提醒，无条件重发会出现两条完整提醒，周期也多算一次。
  // 保留段只有简短提醒时，完整说明已被摘要，仍要重发。
  const planModeReminderBody = hasFullRuntimeModeReminder(preservedEntries)
    ? null
    : buildRuntimeModeReminderBody([], runtime.getMode(), runtime.getPlanEnabled());
  // compaction 附件顺序：文件恢复 → plan 文件 → plan 提醒 → ToolSearch 公告
  // → agent listing → skill 列表 → 环境 → 模型 → 输出风格。
  // 修复原因：agent listing 排在文件恢复之前，顺序错误。
  const postCompactReminderEntries = [
    ...fileRestore.entries,
    ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
    ...(planModeReminderBody
      ? [systemReminderAttachmentEntry("runtime_mode", planModeReminderBody)]
      : []),
    ...(toolAnnouncement ? [toolAnnouncement] : []),
    ...(agentListingEntry ? [agentListingEntry] : []),
    ...(skillsListingEntry ? [skillsListingEntry] : []),
    ...restateContextAfterCompact(runtime, activeEntries, preservedEntries),
  ];

  return { discovery, leadingReminderEntries, postCompactReminderEntries, fileRestore };
}

export async function publishCompactModelComplete(
  runtime: AgentRuntimeInternal,
  result: RuntimeModelTextResult,
  summary: string,
  traceContext: TraceContext,
  events: SessionEvent[],
): Promise<void> {
  const event = runtime.createEvent(
    SessionEventType.ModelComplete,
    {
      content: summary,
      stopReason: result.finishReason,
      usage: result.usage,
      querySource: "compact",
      toolCallCount: 0,
    },
    traceContext,
  );
  await runtime.appendEvent(event, traceContext);
  events.push(event);
}
