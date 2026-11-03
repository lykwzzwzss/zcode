import {
  DECOMPRESS_CONTEXT_TOOL_NAME,
  COMPACT_SUMMARY_ORIGIN_PREFIX,
  CompactSummaryOrigin,
  HookEventName,
  SEARCH_CONTEXT_TOOL_NAME,
} from "@zcode/contracts";
import { buildContextFold } from "../../native-context/contract.js";
import {
  prepareRuntimeProviderRequest,
  shouldFoldRemindersIntoToolResults,
  shouldUseMidConversationSystem,
} from "../helpers/runtime-provider-request-messages.js";
import {
  CompactTrigger,
  CompactTimelineStatus,
  SessionEventType,
  createChildTraceContext,
  createMessageId,
  createPartId,
  traceContextToLogContext,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
} from "../deps.js";
import type { SessionEvent, TraceContext } from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  countCompactPreservedRuntimeMessages,
  buildPostCompactRuntimeEntries,
  compactFailureReasonFromError,
  estimateRuntimeEntryTokens,
  getRuntimeEntriesToSummarize,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntriesAfterPromptTooLong,
  throwIfTurnAborted,
  isTurnCancellationError,
  isModelContextExceededError,
  isModelMediaTooLargeError,
  logMediaBudgetProjection,
  logMediaCapabilityProjection,
  truncateCompactSummaryRequestEntriesAfterPromptTooLong,
  projectCompactMediaForRetry,
  projectMessagesForModelMediaPolicy,
  logCompactMediaRetryProjection,
} from "../helpers/index.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";
import {
  legacySyntheticRuntimeMetadata,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { selectPersistedCompactTail } from "../helpers/compact-preservation.js";
import {
  publishCompactModelComplete,
  applyOrDeferCommittedCompactState,
  finalizeCommittedCompactApply,
  buildCompactSummaryRequestMessages,
  createCompactContextExceededFinishError,
  createCompactPromptTooLongError,
  formatCompactSummaryOrThrow,
  finishSkippedCompact,
  skipNonShrinkingCompact,
  logCommittedCompactFailure,
  persistCompactTimelineEvent,
  renderCompactHookTranscript,
  invalidModelCompactRanges,
} from "./compact-active-helpers.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { compactActiveConversationWithRanges } from "./compact-active-ranges.js";
import { createRefreshRuntimeHeadersBeforeModelAttempt } from "./model-runtime-headers.js";
import { recordModelUsageFact } from "./usage-observability.js";
import { createRuntimeModel } from "./runtime-model.js";
import { filterOutputTokenContinuationEntries } from "./turn-output-token-continuation.js";
import {
  isAutoCompactRetryableError,
  resolveCompactSummaryModel,
  toCompactCacheUsage,
  canUseCompactSummaryTruncationFallback,
  selectInitialCompactEntriesForActiveConversation,
  capCompactSummaryMaxOutputTokens,
  splitRetainedSummaries,
} from "../../native-context/summary-policy.js";
import { prepareCompactReminders, type CompactActiveOptions } from "./compact-active-helpers.js";

const AUTO_COMPACT_MAX_ATTEMPTS = 3;
// 模型入口守卫的稳定跳过原因码：timeline 终态需要机器可读原因，不能依赖展示文案。
const MODEL_SOURCE_GUARD_SKIP_REASON = "model_source_invalid_ranges_or_summaries";

export async function compactActiveConversation(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: CompactActiveOptions = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactTelemetry = this.agentTelemetry.compaction({
    trigger,
    phase,
    maxAttempts: AUTO_COMPACT_MAX_ATTEMPTS,
    modelMode: this.config.modelStreaming === "off" ? "non_streaming" : "streaming",
    policyContextWindowTokens: options.compactContextTelemetry?.policyContextWindowTokens,
    thresholdTokens: options.compactContextTelemetry?.thresholdTokens,
    tokenSource: options.compactContextTelemetry?.tokenSource,
    traceContext: turnTraceContext,
  });
  if (options.compactContextTelemetry) {
    // Auto 复用策略决策，Reactive 复用 overflow 路径 activeMessages；其他 trigger 不额外投影。
    compactTelemetry.setInputTokens(options.compactContextTelemetry.inputTokens);
  }
  return compactTelemetry.run(async () => {
    try {
      const result = await compactActiveConversationImpl.call(
        this,
        customInstructions,
        turnTraceContext,
        events,
        options,
      );
      compactTelemetry.setOutputTokens(result.tokenCount);
      compactTelemetry.finishCompleted();
      return result;
    } catch (error) {
      if (isTurnCancellationError(error, options.abortSignal)) {
        compactTelemetry.finishCancelled("abort_signal");
      } else {
        compactTelemetry.finishFailed("unhandled", "unknown", error);
      }
      throw error;
    }
  });
}

async function compactActiveConversationImpl(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: CompactActiveOptions = {},
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  throwIfTurnAborted(options.abortSignal);
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  // 模型入口不得因漏范围或摘要掉进 legacy 独立摘要路径；其它入口不受该守卫影响。
  if (options.modelCompact) {
    const invalidModelRequest = invalidModelCompactRanges(options.ranges);
    if (invalidModelRequest) {
      options.modelCompact.slot.current = undefined;
      const entries = options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries();
      // 与 ranges/legacy 的 Skipped 口径一致：窗口属于继续会话的模型，不是外部摘要模型。
      const preCompactTokenCount = estimateRuntimeEntryTokens(entries, {
        useMidConversationSystem: options.model
          ? shouldUseMidConversationSystem(this.config, options.model)
          : false,
      });
      // 拒绝也发生在压缩执行器内，必须留下 skipped 终态；不生成摘要、不修改活跃历史。
      return finishSkippedCompact(
        this,
        {
          operationId: `cmp_${crypto.randomUUID()}`,
          messageId: createMessageId(),
          partId: createPartId(),
          trigger,
          phase,
          compactReason,
          ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
          startedAt: Date.now(),
          preCompactTokenCount,
        },
        entries,
        turnTraceContext,
        events,
        invalidModelRequest,
        MODEL_SOURCE_GUARD_SKIP_REASON,
      );
    }
  }
  // 选择性区间压缩走独立执行器：legacy「折叠最旧前缀」路径完全不动，
  // 只有显式带 ranges 的请求才进入；不带 ranges 时行为与旧版本逐字节一致。
  if (options.ranges && options.ranges.length > 0) {
    return compactActiveConversationWithRanges.call(
      this,
      customInstructions,
      turnTraceContext,
      events,
      options,
    );
  }
  const defaultCompactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  // 明确的目录校验失败才回退；目录/工厂内部异常继续上抛，摘要调用仍禁止执行工具。
  const compactModelResolution = resolveCompactSummaryModel({
    catalog: this.modelCatalogPort,
    configured: this.config.compactSummaryModel,
    createModel: (selection) => createRuntimeModel(this, { selection }),
    fallbackModel: defaultCompactModel,
    logContext: traceContextToLogContext(turnTraceContext),
    logger: this.logger,
  });
  const compactModel = compactModelResolution.model;
  // Active compact 会跨多个 await 保留这份成员浅快照；它依赖 RuntimeMessageEntry
  // 不可变约定。selection、provider render 和最终 replace 会创建各自拥有的副本，
  // 禁止在 compact 期间原地修改 activeEntries 内共享的 entry/message/content。
  const activeEntries = [
    ...(options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries()),
  ];
  const useMidConversationSystem = shouldUseMidConversationSystem(this.config, compactModel);
  // 窗口属于继续会话的模型，不能让外部摘要模型的投影能力改变压缩收益和阈值。
  const continuationMcs = shouldUseMidConversationSystem(this.config, defaultCompactModel);
  const initialSelection = selectInitialCompactEntriesForActiveConversation({
    activeEntries,
    initialPromptTooLongCause: options.initialPromptTooLongCause,
    trigger,
    useMidConversationSystem: continuationMcs,
  });
  let currentSelection = initialSelection;
  let preservedEntries = currentSelection.preservedEntries;
  const initialEntriesForSummary = currentSelection.entriesForSummary;
  // 增量折叠：按 token 预算保留稳定摘要；超预算的旧层进入下一层，避免保留层数硬上限。
  const initialSplit = splitRetainedSummaries(initialEntriesForSummary);
  let priorSummaryEntries = initialSplit.priorSummaryEntries;
  let entriesForSummary = initialSplit.entriesForSummary;
  // 被并进本次摘要的旧层 boundaryId；重选后必须跟着这份最终拆分走，否则会记录错误的父链。
  let mergedSummaryBoundaryIds = initialSplit.mergedSummaryBoundaryIds;
  // 重试路径要复用这份拆分结果：直接退回 initialEntriesForSummary 会改变首试/重试行为。
  const entriesForSummaryAfterExclusion = entriesForSummary;
  let entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem: continuationMcs,
  });
  const maxAttempts = trigger === CompactTrigger.Auto ? AUTO_COMPACT_MAX_ATTEMPTS : 1;
  let attempt = 1;
  const compactTimeline = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    ...(options.sourceCommandId ? { sourceCommandId: options.sourceCommandId } : {}),
    startedAt: Date.now(),
    preCompactTokenCount,
  } satisfies CompactTimelineContext;

  if (!hasEnoughRuntimeEntriesToCompact(entriesForSummary)) {
    // 刚压缩过或历史太少时，/compact 是健康 no-op，不能暴露成系统故障。
    return finishSkippedCompact(
      this,
      compactTimeline,
      activeEntries,
      turnTraceContext,
      events,
      "Context is up to date; no compression needed",
    );
  }

  // 宿主发起压缩：压缩前先问插件"这一段你愿意自己折吗"。
  // - 返回 additionalContext：追加进本次摘要请求的附加指令（与调用方 instructions 合并）；
  // - 返回 compactionSummary：折叠正文由宿主提供，跳过模型摘要请求；
  // - 返回 continue:false / decision:"block"：取消本次折叠，保持上下文原样。
  const preCompactHookResult = await this.runPreCompactHooks(
    {
      entriesToSummarize: entriesToSummarize.length,
      // 折叠正文由钩子自己写时，它必须读到原文；钩子只看条数写不出任何东西。
      // 没有钩子就不渲染：这一份可能是几十万 token 的历史，白算一次纯亏。
      entriesTranscript: this.hookRunner
        ? renderCompactHookTranscript(entriesForSummary, { useMidConversationSystem })
        : undefined,
      historyTokens: preCompactTokenCount,
      reason: compactReason,
      summarizeTokens: estimateRuntimeEntryTokens(entriesForSummary, { useMidConversationSystem }),
      trigger,
    },
    turnTraceContext,
    options.abortSignal,
  );
  const hostCompactionSummary = preCompactHookResult.compactionSummary?.trim();
  // hook 指令与调用方 instructions 合并后再进 prompt 和 boundary：否则模型收到的摘要
  // 要求与会话里记录的 customInstructions 不一致，事后无法还原这次折叠实际用了什么。
  const hookInstructions = preCompactHookResult.additionalContexts
    .map((context) => context.trim())
    .filter((context) => context.length > 0);
  const effectiveCustomInstructions =
    hookInstructions.length === 0
      ? customInstructions
      : [customInstructions?.trim(), ...hookInstructions]
          .filter((instruction): instruction is string => Boolean(instruction))
          .join("\n\n");

  if (preCompactHookResult.blockRequested) {
    const blockedReason = preCompactHookResult.stopReason?.trim();
    return finishSkippedCompact(
      this,
      compactTimeline,
      activeEntries,
      turnTraceContext,
      events,
      blockedReason
        ? `Compaction cancelled by a plugin hook: ${blockedReason}`
        : "Compaction cancelled by a plugin hook",
    );
  }

  const compactStartedPayload = this.buildCompactTimelinePayload(compactTimeline, {
    reason:
      COMPACT_SUMMARY_ORIGIN_PREFIX +
      (hostCompactionSummary !== undefined
        ? CompactSummaryOrigin.HostProvided
        : CompactSummaryOrigin.RuntimeGenerated),
    ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
    status: CompactTimelineStatus.Started,
  });
  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    compactStartedPayload,
    turnTraceContext,
    events,
  );
  await this.initializeMcp(turnTraceContext);
  throwIfTurnAborted(options.abortSignal);
  // 与主循环同一份工具目录（含本轮禁用规则），由同一个请求准备入口投影。
  // 修复原因：摘要请求另选工具（只带 ToolSearch 相关工具，或超过 100 个时发空列表）时，
  // tools 段与主循环不同，整个摘要请求不命中主循环的前缀缓存。
  const compactCandidates = options.getContinuationTools?.() ?? this.getTools(compactModel);
  const continuationTools = options.getContinuationTools
    ? compactCandidates
    : this.getTools(defaultCompactModel);
  const registry = this.getToolRegistry();

  let compactCommitted = false;
  while (true) {
    try {
      const lastSummarizedMessageId = this.latestConversationMessageId;
      const modelTraceContext = createChildTraceContext(turnTraceContext, {
        attributes: {
          model: `${compactModel.providerId}/${compactModel.modelId}`,
          querySource: "compact",
        },
      });
      const compactPrompt = buildCompactPrompt(effectiveCustomInstructions);
      let result: RuntimeModelTextResult;
      let compactPromptTooLongAttempts = 0;
      let stripMediaForSummary = false;
      const reselectEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        const reselected = selectCompactEntriesAfterPromptTooLong({
          currentGroupsPreserved: currentSelection.groupsPreserved,
          entries: activeEntries,
          promptTooLongCause: cause,
          trigger,
          useMidConversationSystem,
        });
        if (!reselected) return false;

        compactPromptTooLongAttempts += 1;
        currentSelection = reselected;
        preservedEntries = reselected.preservedEntries;
        entriesForSummary = reselected.entriesForSummary;
        // 重新选择后同样只摘掉要保留的那几层；更早的层继续进摘要请求。
        // 这里禁用非增量回退：重选阶段没有 skipped 风险，把旧摘要重新灌回去
        // 只会在 prompt-too-long 恢复链上二次撑大请求。
        const reselectedSplit = splitRetainedSummaries(entriesForSummary, false);
        priorSummaryEntries = reselectedSplit.priorSummaryEntries;
        entriesForSummary = reselectedSplit.entriesForSummary;
        mergedSummaryBoundaryIds = reselectedSplit.mergedSummaryBoundaryIds;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };
      const truncateEntriesAfterPromptTooLong = (cause: unknown): boolean => {
        if (!canUseCompactSummaryTruncationFallback(trigger)) return false;

        const truncated = truncateCompactSummaryRequestEntriesAfterPromptTooLong({
          attempt: compactPromptTooLongAttempts,
          cause,
          entriesForSummary,
          logger: this.logger,
          traceContext: modelTraceContext,
          useMidConversationSystem,
        });
        if (!truncated) return false;

        compactPromptTooLongAttempts += 1;
        entriesForSummary = truncated;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        return true;
      };

      if (hostCompactionSummary !== undefined) {
        // 宿主发起折叠（dsh 的 AUTHORED_COMPACTION 等价物）：PreCompact 钩子已给出
        // 折叠正文，这里不再发模型摘要请求。usage 记 0——这次折叠确实没有模型调用，
        // 记账必须诚实，否则边界元数据里的 token 数会凭空多出一笔。
        result = {
          finishReason: "stop",
          text: hostCompactionSummary,
          usage: { totalTokens: 0 },
        };
      } else {
        while (true) {
          const prepared = prepareRuntimeProviderRequest(this, {
            model: compactModel,
            tools: compactCandidates,
            registry,
            // 保留段中的发现事实也决定主请求的 tools；裁掉它会让摘要请求从 tools 段失去缓存。
            toolExposureEntries: activeEntries,
            entries: entriesForSummary,
            prompt: compactPrompt,
            applyCacheControl: true,
            skipCacheWrite: true,
          });
          const recordableEntries = filterOutputTokenContinuationEntries(prepared.entries);
          const recordableRequestMessages =
            recordableEntries === prepared.entries
              ? prepared.request.messages
              : buildCompactSummaryRequestMessages(recordableEntries, compactPrompt, {
                  useMidConversationSystem,
                  foldRemindersIntoToolResults: shouldFoldRemindersIntoToolResults(compactModel),
                  loadedToolCallIds: prepared.loadedToolCallIds,
                });
          // Compact 曾只执行 capability projection，漏掉普通 turn 共用的聚合
          // 媒体预算；统一走模型媒体策略，避免 summary 请求绕过全局请求上限。
          const mediaPolicyProjection = projectMessagesForModelMediaPolicy(
            prepared.request.messages,
            compactModel.properties.inputFormat,
          );
          logMediaCapabilityProjection(
            this.logger,
            modelTraceContext,
            mediaPolicyProjection.capabilityProjection,
            {
              event: "compact.request.media_capability_projection",
              message: "Compact request media capability projection",
              model: `${compactModel.providerId}/${compactModel.modelId}`,
            },
          );
          logMediaBudgetProjection(
            this.logger,
            modelTraceContext,
            mediaPolicyProjection.mediaBudgetProjection,
            {
              event: "compact.request.media_projection",
              message: "Compact request media budget projection",
            },
          );
          let projectedRequestMessages = mediaPolicyProjection.messages;
          let projectedRecordableMessages =
            recordableRequestMessages === prepared.request.messages
              ? projectedRequestMessages
              : projectMessagesForModelMediaPolicy(
                  recordableRequestMessages,
                  compactModel.properties.inputFormat,
                ).messages;
          if (stripMediaForSummary) {
            // 复用通用 media budget 文案会污染 summary 的 provider-visible 内容。
            const mediaProjection = projectCompactMediaForRetry(projectedRequestMessages);
            projectedRequestMessages = mediaProjection.messages;
            projectedRecordableMessages =
              recordableRequestMessages === prepared.request.messages
                ? projectedRequestMessages
                : projectCompactMediaForRetry(projectedRecordableMessages).messages;
            logCompactMediaRetryProjection(this.logger, modelTraceContext, mediaProjection);
          }

          const modelRequestEvent = this.createEvent(
            SessionEventType.ModelRequest,
            {
              // 事件误用了含 Continue 的实际请求数组，导致 query-local 提示进入持久化轨迹。
              // 与 v0.16.6 一致：事件记录过滤后的投影，下面的 provider 请求仍使用完整上下文。
              messages: projectedRecordableMessages,
              providerId: String(compactModel.providerId),
              modelId: String(compactModel.modelId),
              querySource: "compact",
              toolCount: prepared.request.tools.length,
              compactPromptTooLongRetry: compactPromptTooLongAttempts,
            },
            modelTraceContext,
          );
          await this.appendEvent(modelRequestEvent, modelTraceContext);
          events.push(modelRequestEvent);
          const modelStartedAt = Date.now();
          const networkEventStartIndex = events.length;
          const compactSummaryMaxOutputTokens = capCompactSummaryMaxOutputTokens(compactModel);
          const compactModelRequest = {
            abortSignal: options.abortSignal,
            maxOutputTokens: compactSummaryMaxOutputTokens,
            messages: projectedRequestMessages,
            metadata: traceContextToLogContext(modelTraceContext),
            modelCall: {
              attributes: {
                compactionOuterAttempt: attempt,
                compactionTrigger: trigger,
              },
              operation: "context_compaction" as const,
              operationId: compactTimeline.operationId,
            },
            statusSink: this.createModelStatusSink(modelTraceContext, events),
            // compact 的首个真实 provider event 结束 SSE retry 资格；隐藏 partial 在
            // content block 提交前仍可丢弃并 HTTP fallback，block end 后则禁止任何重放。
            preserveProviderStreamBoundaries: true,
            traceContext: modelTraceContext,
            tools: prepared.request.tools,
            toolSearchEnabled: prepared.request.toolSearchEnabled,
            refreshRuntimeHeadersBeforeAttempt: createRefreshRuntimeHeadersBeforeModelAttempt(
              this,
              {
                abortSignal: options.abortSignal,
                model: compactModel,
                traceContext: modelTraceContext,
              },
            ),
          };

          try {
            result = await runCompactSummaryModelRequest({
              logger: this.logger,
              model: compactModel,
              request: compactModelRequest,
            });
          } catch (error) {
            await recordModelUsageFact(this, {
              attemptIndex: compactPromptTooLongAttempts,
              error,
              events,
              model: compactModel,
              networkEventStartIndex,
              querySource: "compact",
              startedAt: modelStartedAt,
              status: isTurnCancellationError(error, options.abortSignal) ? "cancelled" : "error",
              traceContext: modelTraceContext,
            });
            if (isTurnCancellationError(error, options.abortSignal)) {
              throw error;
            }
            if (isModelMediaTooLargeError(error) && !stripMediaForSummary) {
              stripMediaForSummary = true;
              this.logger?.info(
                "Compact summary hit media-size error; retrying with stripped media",
                {
                  ...traceContextToLogContext(modelTraceContext),
                  errorMessage: error instanceof Error ? error.message : String(error),
                  event: "compact.request.media_too_large.retry",
                  module: "core.runtime",
                },
              );
              continue;
            }
            if (isModelContextExceededError(error)) {
              if (reselectEntriesAfterPromptTooLong(error)) continue;
              if (truncateEntriesAfterPromptTooLong(error)) continue;
              throw createCompactPromptTooLongError({
                attempt: compactPromptTooLongAttempts,
                cause: error,
                preCompactTokenCount,
              });
            }
            throw error;
          }

          await recordModelUsageFact(this, {
            attemptIndex: compactPromptTooLongAttempts,
            events,
            model: compactModel,
            networkEventStartIndex,
            querySource: "compact",
            result,
            startedAt: modelStartedAt,
            status: "completed",
            toolCallCount: this.extractToolCallsFromResult(result).length,
            traceContext: modelTraceContext,
          });
          const contextError = createCompactContextExceededFinishError(result);
          if (contextError) {
            // compact summary 也可能以 finishReason 返回超窗而不是 throw；
            // 必须先进入同一套 recent preserve 重选逻辑，避免 finishReason 路径丢上下文。
            if (reselectEntriesAfterPromptTooLong(contextError)) continue;
            if (truncateEntriesAfterPromptTooLong(contextError)) continue;
            throw createCompactPromptTooLongError({
              attempt: compactPromptTooLongAttempts,
              cause: contextError,
              preCompactTokenCount,
            });
          }
          break;
        }
      }

      const summary = formatCompactSummaryOrThrow(this, result);
      // 修复原因：文件恢复曾用读取状态里缓存的视图，补回的可能是旧内容或片段；现在重读当前文件。
      // plan 文件和补回文件互不依赖，并行读取。
      const { discovery, leadingReminderEntries, postCompactReminderEntries, fileRestore } =
        await prepareCompactReminders(this, {
          options,
          activeEntries,
          preservedEntries,
          continuationModel: defaultCompactModel,
          continuationTools,
          registry,
          modelTraceContext,
        });

      // 钩子直接给正文时没有真实摘要请求，不伪造一条零用量的模型完成事件。
      if (hostCompactionSummary === undefined)
        await publishCompactModelComplete(this, result, summary, modelTraceContext, events);

      const summaryMessageId = createMessageId();
      const summaryMessageContent = buildCompactSummaryMessage(summary, {
        // 与 summary 之前的请求前公告用同一判定：保留段非空。
        preservedMessagesKept: preservedEntries.length > 0,
        // 注册不等于当轮可调用；只用继续会话的有效工具目录生成取回指引。
        retrievalToolsAvailable:
          continuationTools.some((tool) => tool.name === SEARCH_CONTEXT_TOOL_NAME) &&
          continuationTools.some((tool) => tool.name === DECOMPRESS_CONTEXT_TOOL_NAME),
        suppressFollowup: true,
      });
      // Continue 没有对应 Session message；无 store 的统计也不能把它计入保留记录。
      const recordablePreservedEntries = filterOutputTokenContinuationEntries(preservedEntries);
      const preservation = this.sessionStore
        ? await selectPersistedCompactTail({
            sessionStore: this.sessionStore,
            sessionId: this.sessionId,
            groupsPreserved: currentSelection.groupsPreserved,
            summaryMessageId,
          })
        : { keptMessageCount: countCompactPreservedRuntimeMessages(recordablePreservedEntries) };
      const summaryEntry = {
        messageId: summaryMessageId,
        message: { role: "user" as const, content: summaryMessageContent },
        metadata: {
          ...legacySyntheticRuntimeMetadata(),
          compactBoundary: discovery,
          // 重试只缩短模型请求；取回关系必须覆盖实际移除的完整选区。
          compactHierarchy: buildContextFold(
            currentSelection.entriesForSummary,
            priorSummaryEntries,
          ),
          // 把本次真正并掉的旧层记进 runtime entry：同一进程内的下一次折叠会把它
          // 当「已代理集合」继续并入新摘要，形成可传递的 covers 闭包。
          // 落盘仍在 persistOptions.coversBoundaryIds；这里只是活视图的副本。
          ...(mergedSummaryBoundaryIds.length > 0
            ? { coversBoundaryIds: [...mergedSummaryBoundaryIds] }
            : {}),
        },
      };
      const postCompactEntries = buildPostCompactRuntimeEntries(activeEntries, summaryEntry, {
        leadingReminderEntries,
        priorSummaryEntries,
        postCompactReminderEntries,
        preservedEntries,
      });
      const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
        useMidConversationSystem: continuationMcs,
      });
      const skipped = await skipNonShrinkingCompact(this, {
        timeline: compactTimeline,
        entries: activeEntries,
        postTokens: truePostCompactTokenCount,
        model: defaultCompactModel,
        autoCompactThreshold: options.autoCompactThreshold,
        abortSignal: options.abortSignal,
        traceContext: turnTraceContext,
        events,
      });
      if (skipped) return skipped;
      // 折叠本身的开销只在这个摘要请求返回时可见；重试/增量折叠成功后最终走的都是
      // 下面同一条 boundary 落盘路径，所以在这里取一次即可覆盖两条分支。
      const cacheUsage = toCompactCacheUsage(result.usage);
      if (preservedEntries.length > 0 && !preservation.preservedSegment) {
        // live 保留了尾巴、boundary 却没声明：冷恢复会把这一段丢掉，至少留痕。
        this.logger?.warn("Compact preserved entries have no persisted segment", {
          ...traceContextToLogContext(turnTraceContext),
          event: "compact.preserved_segment.missing",
          module: "core.runtime",
          preservedEntryCount: preservedEntries.length,
          status: "failed",
        });
      }
      const compactBoundary = buildManualCompactBoundary({
        ...discovery,
        autoCompactThreshold: options.autoCompactThreshold,
        compactReason,
        customInstructions: effectiveCustomInstructions,
        lastSummarizedMessageId,
        phase,
        postCompactTokenCount: truePostCompactTokenCount,
        preCompactTokenCount,
        summarizedMessageCount: entriesToSummarize.length,
        summaryMessageId,
        traceContext: turnTraceContext,
        trigger,
        ...(currentSelection.groupsPreserved > 0
          ? {
              keptMessageCount: preservation.keptMessageCount,
            }
          : {}),
        preservedSegment: preservation.preservedSegment,
        truePostCompactTokenCount,
        willRetriggerNextTurn:
          options.autoCompactThreshold !== undefined
            ? truePostCompactTokenCount >= options.autoCompactThreshold
            : undefined,
      });

      // 发现检查点跟随 summary 原子保存；持久化成功后才替换 Runtime 历史。
      const persistOptions = {
        hierarchy: summaryEntry.metadata.compactHierarchy,
        retainedSummaryMessageIds: priorSummaryEntries.flatMap((entry) =>
          entry.kind !== "attachment" && entry.messageId
            ? [entry.messageId as import("@zcode/contracts").MessageId]
            : [],
        ),
        model: compactModel,
        operationId: compactTimeline.operationId,
        cacheUsage,
        leadingReminderEntries,
        postCompactReminderEntries,
        // 父子映射：记下这次真正被并进新摘要的旧层，读侧才能把已消失的摘要解析到覆盖它的层。
        // 空数组不落盘（旧 boundary 没有该字段，读侧按「无覆盖关系」降级）。
        ...(mergedSummaryBoundaryIds.length > 0
          ? { coversBoundaryIds: mergedSummaryBoundaryIds }
          : {}),
        // 旧摘要正文随这一组一起落盘，冷恢复才看得见（否则重启后只剩最新一层）。
        retainedSummaries: priorSummaryEntries.flatMap((entry) => {
          if (entry.kind === "attachment" || entry.messageId) return [];
          const content = entry.message.content;
          return typeof content === "string" && content.trim() ? [content.trim()] : [];
        }),
      };
      // ModelComplete、保留段读取等 await 后仍可能被取消；提交是最后的可取消边界。
      throwIfTurnAborted(options.abortSignal);
      await this.persistCompactSummary(
        summaryMessageId,
        summaryMessageContent,
        summary,
        compactBoundary,
        modelTraceContext,
        persistOptions,
      );
      compactCommitted = true;
      // 已落盘的历史必须在事件发布前生效；后续写入失败不能让本进程继续使用旧上下文。
      applyOrDeferCommittedCompactState(this, {
        entries: postCompactEntries,
        preserveCanonicalPrefix: options.activeEntries !== undefined,
        readFileStateEntries: fileRestore.readFileStateEntries,
        summaryMessageId,
        tokenCount: truePostCompactTokenCount,
      });

      const compactBoundaryEvent = this.createEvent(
        SessionEventType.CompactBoundary,
        compactBoundary,
        turnTraceContext,
      );
      await this.appendEvent(compactBoundaryEvent, turnTraceContext);
      events.push(compactBoundaryEvent);

      const compactCompletedPayload = this.buildCompactTimelinePayload(compactTimeline, {
        reason:
          COMPACT_SUMMARY_ORIGIN_PREFIX +
          (hostCompactionSummary !== undefined
            ? CompactSummaryOrigin.HostProvided
            : CompactSummaryOrigin.RuntimeGenerated),
        ...(maxAttempts > 1 ? { attempt, maxAttempts } : {}),
        boundaryId: compactBoundary.boundaryId,
        endedAt: Date.now(),
        postCompactTokenCount: truePostCompactTokenCount,
        replace: true,
        status: CompactTimelineStatus.Completed,
        summaryMessageId,
        tailStartMessageId: lastSummarizedMessageId,
        truePostCompactTokenCount,
      });
      await persistCompactTimelineEvent(
        this,
        SessionEventType.CompactCompleted,
        compactCompletedPayload,
        turnTraceContext,
        events,
      );

      // PostCompact 只观察已提交的活跃历史，不能在摘要尚未落盘时提前通知插件。
      const postCompactHookResult = await this.runPostCompactHooks(
        {
          keptEntries: postCompactEntries.length,
          postCompactTokens: truePostCompactTokenCount,
          preCompactTokens: preCompactTokenCount,
          reason: compactReason,
          savedTokens: preCompactTokenCount - truePostCompactTokenCount,
          summaryChars: summary.length,
          trigger,
        },
        turnTraceContext,
        options.abortSignal,
      );
      // 注入必须排在 replaceMessages 之后：先注入会被这次替换覆盖掉。
      const postCompactHookEntry = this.injectHookAdditionalContextIntoMessageHistory(
        HookEventName.PostCompact,
        postCompactHookResult.additionalContexts,
      );
      // 提交后的后续步骤已全部成功，下一次请求不再需要重放这份提交。
      finalizeCommittedCompactApply(this);

      return {
        displayText: "Compacted",
        // auto/reactive/CompactNow 会用这份 entries 覆盖 turn request 状态；
        // 只写进 messageHistory 不够，hook 提醒必须同时出现在返回值里。
        entries: postCompactHookEntry
          ? [...postCompactEntries, postCompactHookEntry]
          : postCompactEntries,
        outcome: "compacted",
        tokenCount: truePostCompactTokenCount,
      };
    } catch (error) {
      // 事件/完成时间线/钩子报错不代表摘要未提交；重试会重复折叠并与磁盘分叉。
      if (compactCommitted) {
        logCommittedCompactFailure(this, error, compactTimeline, turnTraceContext);
        throw error;
      }
      if (
        trigger === CompactTrigger.Auto &&
        attempt < maxAttempts &&
        !isTurnCancellationError(error, options.abortSignal) &&
        isAutoCompactRetryableError(error)
      ) {
        attempt += 1;
        const retryPayload = this.buildCompactTimelinePayload(compactTimeline, {
          attempt,
          maxAttempts,
          reason: compactFailureReasonFromError(error),
          status: CompactTimelineStatus.Retrying,
        });
        // 自动 compact 的中间失败不能提前落成 failed 横线。
        // 这里在同一个 operation 上发 retrying，直到第 3 次仍失败才写最终 failed。
        await persistCompactTimelineEvent(
          this,
          SessionEventType.CompactStarted,
          retryPayload,
          turnTraceContext,
          events,
        );
        this.logger?.warn("Auto compact retrying", {
          ...traceContextToLogContext(turnTraceContext),
          attempt,
          errorMessage: error instanceof Error ? error.message : String(error),
          event: "compact.auto.retrying",
          maxAttempts,
          module: "core.runtime",
          timelineStatus: CompactTimelineStatus.Retrying,
        });
        currentSelection = initialSelection;
        preservedEntries = currentSelection.preservedEntries;
        entriesForSummary = entriesForSummaryAfterExclusion;
        // 重试回到首试的拆分结果，父子映射也必须回到同一份拆分，否则会记下重选尝试的旧层。
        mergedSummaryBoundaryIds = initialSplit.mergedSummaryBoundaryIds;
        entriesToSummarize = getRuntimeEntriesToSummarize(entriesForSummary);
        continue;
      }
      await this.finishCompactTimelineFailure({
        abortSignal: options.abortSignal,
        attempt,
        error,
        events,
        maxAttempts: maxAttempts > 1 ? maxAttempts : undefined,
        timeline: compactTimeline,
        traceContext: turnTraceContext,
      });
      throw error;
    }
  }
}

export {
  resolveCompactSummaryModel,
  capCompactSummaryMaxOutputTokens,
} from "../../native-context/summary-policy.js";
export type {
  CompactSummaryModelFallbackReason,
  CompactSummaryModelResolution,
} from "../../native-context/summary-policy.js";
