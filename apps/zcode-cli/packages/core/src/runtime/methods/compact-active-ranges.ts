import { toCompactCacheUsage } from "../../native-context/summary-policy.js";
import {
  DECOMPRESS_CONTEXT_TOOL_NAME,
  COMPACT_SUMMARY_ORIGIN_PREFIX,
  CompactSummaryOrigin,
  HookEventName,
  SEARCH_CONTEXT_TOOL_NAME,
  type CompactBoundaryPayload,
  type CompactRangeInput,
  type CompactRangeMetadata,
  type ModelToolContract,
} from "@zcode/contracts";
import {
  cloneRuntimeMessageEntry,
  countContextPrefixMessages,
  legacySyntheticRuntimeMetadata,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { planCompactRanges } from "../../native-context/range-planner.js";
export { planCompactRanges } from "../../native-context/range-planner.js";
export type { PlannedCompactRange, CompactRangePlan } from "../../native-context/range-planner.js";
import { buildContextFold } from "../../native-context/contract.js";
import { buildToolSearchAnnouncement } from "../../tool/search/exposure.js";
import { collectDiscoveredTools, compactDiscoveryMetadata } from "../../tool/search/history.js";
import {
  CompactPhase,
  CompactReason,
  CompactTimelineStatus,
  CompactTrigger,
  SessionEventType,
  buildCompactPrompt,
  buildCompactSummaryMessage,
  buildManualCompactBoundary,
  createChildTraceContext,
  createCompactBoundaryId,
  createMessageId,
  createPartId,
  traceContextToLogContext,
} from "../deps.js";
import type { Model, SessionEvent, TraceContext } from "../deps.js";
import { collectRuntimeAgentListing } from "../helpers/agent-listing.js";
import { estimateRuntimeEntryTokens } from "../helpers/compact-selection.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  readApprovedPlanFileReferenceEntry,
  restorePostCompactFiles,
  throwIfTurnAborted,
} from "../helpers/index.js";
import { buildRuntimeModeReminderBody } from "../helpers/runtime-reminders.js";
import {
  prepareRuntimeProviderRequest,
  shouldUseMidConversationSystem,
} from "../helpers/runtime-provider-request-messages.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { CompactTimelineContext, RuntimeModelTextResult } from "../types.js";
import { capCompactSummaryMaxOutputTokens, resolveCompactSummaryModel } from "./compact-active.js";
import {
  applyOrDeferCommittedCompactState,
  finalizeCommittedCompactApply,
  formatCompactSummaryOrThrow,
  skipNonShrinkingCompact,
  logCommittedCompactFailure,
  persistCompactTimelineEvent,
  renderCompactHookTranscript,
  checkModelCompactPreparation,
  type ModelCompactSource,
} from "./compact-active-helpers.js";
import {
  buildCompactTimelinePayload,
  finishCompactTimelineFailure,
  persistCompactSummaries,
  type PersistedCompactSummaryRecord,
} from "./compact-persistence.js";
import { collectSkillsListing, restateContextAfterCompact } from "./context-refresh.js";
import { runCompactSummaryModelRequest } from "./compact-summary-model-request.js";
import { createRuntimeModel } from "./runtime-model.js";
import type { CompactAttemptOutcome } from "./turn-loop-state.js";

const MAX_CONCURRENT_COMPACT_RANGE_REQUESTS = 2;

/**
 * 用区间摘要原位替换历史：prefix 原样保留，区间外消息逐条保留，区间位置换成 summary entry，
 * 最后追加本次操作级提醒。区间按位置升序处理，互不重叠（planCompactRanges 已保证）。
 */
export function buildPostCompactRuntimeEntriesForRanges(
  activeEntries: readonly RuntimeMessageEntry[],
  replacements: readonly {
    startIndex: number;
    endIndex: number;
    summaryEntry: RuntimeMessageEntry;
  }[],
  reminderEntries: readonly RuntimeMessageEntry[] = [],
): RuntimeMessageEntry[] {
  const prefixCount = countContextPrefixMessages(activeEntries);
  const entries: RuntimeMessageEntry[] = activeEntries
    .slice(0, prefixCount)
    .map(cloneRuntimeMessageEntry);
  const sortedReplacements = [...replacements].sort(
    (left, right) => left.startIndex - right.startIndex,
  );
  let cursor = prefixCount;
  for (const replacement of sortedReplacements) {
    // 段间 gap 与区间外内容按原位置保留：没被选中的历史一个字节都不动。
    const start = Math.max(replacement.startIndex, cursor);
    for (let index = cursor; index < start; index += 1) {
      const entry = activeEntries[index];
      if (entry) entries.push(cloneRuntimeMessageEntry(entry));
    }
    entries.push(cloneRuntimeMessageEntry(replacement.summaryEntry));
    cursor = Math.max(cursor, replacement.endIndex + 1);
  }
  for (let index = cursor; index < activeEntries.length; index += 1) {
    const entry = activeEntries[index];
    if (entry) entries.push(cloneRuntimeMessageEntry(entry));
  }
  for (const entry of reminderEntries) entries.push(cloneRuntimeMessageEntry(entry));
  return entries;
}

/**
 * 选择性区间压缩（方案 A）的执行入口。
 *
 * 与 legacy「折叠最旧前缀」的区别：
 * - 用户显式给出 N 段区间，每段独立摘要、原位替换，未选中的历史（含区间之间的 gap）原样保留；
 * - N 段摘要 + 本次操作级提醒用一次 commitMessageBundle 原子落盘：部分区间落盘会让冷恢复
 *   看到「摘要已替换、边界未写」的中间态；
 * - 整次操作只写一个 timeline（一个 operationId），但每段各有一条 CompactBoundary 事件。
 */
export async function compactActiveConversationWithRanges(
  this: AgentRuntimeInternal,
  customInstructions: string | undefined,
  turnTraceContext: TraceContext,
  events: SessionEvent[],
  options: {
    abortSignal?: AbortSignal;
    autoCompactThreshold?: number;
    compactReason?: CompactReason;
    phase?: CompactPhase;
    trigger?: CompactTrigger;
    model?: Model;
    agentListingTools?: readonly { name: string }[];
    activeEntries?: readonly RuntimeMessageEntry[];
    getContinuationTools?: () => readonly ModelToolContract[];
    ranges?: readonly CompactRangeInput[];
    modelCompact?: ModelCompactSource;
  },
): Promise<{
  displayText: string;
  entries: readonly RuntimeMessageEntry[];
  outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
  tokenCount: number;
}> {
  const trigger = options.trigger ?? CompactTrigger.Manual;
  const phase = options.phase ?? defaultCompactPhaseForTrigger(trigger);
  const compactReason = options.compactReason ?? defaultCompactReasonForTrigger(trigger);
  const defaultCompactModel =
    options.model ??
    createRuntimeModel(this, {
      selection: this.getSessionModelSelection(),
    });
  // 共用摘要模型解析：明确的目录校验失败才 warn 回退，目录/工厂内部异常继续上抛。
  const compactModel =
    options.ranges?.length &&
    options.ranges.every((range) => typeof range.summary === "string" && range.summary.trim())
      ? defaultCompactModel
      : resolveCompactSummaryModel({
          catalog: this.modelCatalogPort,
          configured: this.config.compactSummaryModel,
          createModel: (selection) => createRuntimeModel(this, { selection }),
          fallbackModel: defaultCompactModel,
          logContext: traceContextToLogContext(turnTraceContext),
          logger: this.logger,
        }).model;
  const useMidConversationSystem = shouldUseMidConversationSystem(this.config, compactModel);
  // 窗口与收益按继续会话的模型计算，摘要请求仍使用摘要模型自己的投影。
  const continuationMcs = shouldUseMidConversationSystem(this.config, defaultCompactModel);
  const activeEntries = options.activeEntries ?? this.messageHistory.borrowReadOnlyRuntimeEntries();
  const preCompactTokenCount = estimateRuntimeEntryTokens(activeEntries, {
    useMidConversationSystem: continuationMcs,
  });
  const compactTimeline = {
    operationId: `cmp_${crypto.randomUUID()}`,
    messageId: createMessageId(),
    partId: createPartId(),
    trigger,
    phase,
    compactReason,
    startedAt: Date.now(),
    preCompactTokenCount,
  } satisfies CompactTimelineContext;

  const plan = planCompactRanges(activeEntries, options.ranges ?? []);
  if (!plan.ok) {
    if (options.modelCompact) options.modelCompact.slot.current = undefined;
    // 规划失败不产生任何落盘内容，只把 timeline 收敛为 skipped，链保持不变。
    const payload = buildCompactTimelinePayload.call(this, compactTimeline, {
      endedAt: Date.now(),
      reason: plan.reason,
      replace: true,
      status: CompactTimelineStatus.Skipped,
    });
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      payload,
      turnTraceContext,
      events,
    );
    return {
      displayText: plan.message,
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  }

  // 与 legacy 路径一致：折叠前先跑 PreCompact 钩子。ranges 模式下钩子只看到本次会折的区间，
  // block 时整单 skipped，活跃链保持不变。
  const entriesToSummarize = plan.ranges.flatMap((range) =>
    activeEntries.slice(range.startIndex, range.endIndex + 1),
  );
  const preCompactHookResult = await this.runPreCompactHooks(
    {
      entriesToSummarize: entriesToSummarize.length,
      entriesTranscript: this.hookRunner
        ? renderCompactHookTranscript(entriesToSummarize, { useMidConversationSystem })
        : undefined,
      historyTokens: preCompactTokenCount,
      reason: compactReason,
      summarizeTokens: estimateRuntimeEntryTokens(entriesToSummarize, {
        useMidConversationSystem,
      }),
      trigger,
    },
    turnTraceContext,
    options.abortSignal,
  );
  const skipTimeline = async (options: {
    displayText: string;
    reason?: string;
  }): Promise<{
    displayText: string;
    entries: readonly RuntimeMessageEntry[];
    outcome: Extract<CompactAttemptOutcome, "compacted" | "skipped">;
    tokenCount: number;
  }> => {
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      buildCompactTimelinePayload.call(this, compactTimeline, {
        ...(options.reason ? { reason: options.reason } : {}),
        endedAt: Date.now(),
        replace: true,
        status: CompactTimelineStatus.Skipped,
      }),
      turnTraceContext,
      events,
    );
    return {
      displayText: options.displayText,
      entries: activeEntries,
      outcome: "skipped",
      tokenCount: preCompactTokenCount,
    };
  };
  if (preCompactHookResult.blockRequested) {
    if (options.modelCompact) options.modelCompact.slot.current = undefined;
    const blockedReason = preCompactHookResult.stopReason?.trim();
    return skipTimeline({
      displayText: blockedReason
        ? `Compaction cancelled by a plugin hook: ${blockedReason}`
        : "Compaction cancelled by a plugin hook",
    });
  }
  const hostCompactionSummary = preCompactHookResult.compactionSummary?.trim();
  if (hostCompactionSummary !== undefined && plan.ranges.length > 1) {
    if (options.modelCompact) options.modelCompact.slot.current = undefined;
    // 钩子只能给一份折叠正文；多区间需要 N 段独立摘要，硬套会把同一段摘要塞进每个区间。
    return skipTimeline({
      displayText:
        "PreCompact hook supplied a single compaction summary, but this request folds multiple ranges; no range was compacted.",
      reason: "pre_compact_summary_requires_single_range",
    });
  }
  const hookInstructions = preCompactHookResult.additionalContexts
    .map((context) => context.trim())
    .filter((context) => context.length > 0);
  const submittedSummaries = plan.ranges.every((range) => range.summary !== undefined);
  if (
    options.modelCompact &&
    hostCompactionSummary === undefined &&
    (hookInstructions.length > 0 || options.modelCompact.preparationToken !== undefined)
  ) {
    const prepared = checkModelCompactPreparation({
      source: options.modelCompact,
      entries: activeEntries,
      ranges: plan.ranges,
      requirements: hookInstructions,
    });
    if (!prepared.accepted)
      return skipTimeline({
        reason: "submitted_summary_requires_hook_instructions",
        displayText: prepared.message,
      });
  }
  if (
    !options.modelCompact &&
    submittedSummaries &&
    hookInstructions.length > 0 &&
    hostCompactionSummary === undefined
  ) {
    return skipTimeline({
      reason: "submitted_summary_requires_hook_instructions",
      displayText: `PreCompact added new instructions. Resubmit summaries that follow them: ${hookInstructions.join("\n\n")}`,
    });
  }
  if (
    options.modelCompact &&
    hookInstructions.length === 0 &&
    !options.modelCompact.preparationToken
  )
    options.modelCompact.slot.current = undefined;
  if (options.modelCompact && hostCompactionSummary !== undefined)
    options.modelCompact.slot.current = undefined;
  const summaryOrigin =
    hostCompactionSummary !== undefined
      ? CompactSummaryOrigin.HostProvided
      : submittedSummaries
        ? options.modelCompact
          ? CompactSummaryOrigin.ModelWritten
          : undefined
        : CompactSummaryOrigin.RuntimeGenerated;
  const effectiveCustomInstructions =
    hookInstructions.length === 0
      ? customInstructions
      : [customInstructions?.trim(), ...hookInstructions]
          .filter((instruction): instruction is string => Boolean(instruction))
          .join("\n\n");

  await persistCompactTimelineEvent(
    this,
    SessionEventType.CompactStarted,
    buildCompactTimelinePayload.call(this, compactTimeline, {
      ...(summaryOrigin ? { reason: COMPACT_SUMMARY_ORIGIN_PREFIX + summaryOrigin } : {}),
      status: CompactTimelineStatus.Started,
    }),
    turnTraceContext,
    events,
  );

  let compactCommitted = false;
  try {
    const compactCandidates = options.getContinuationTools?.() ?? this.getTools(compactModel);
    const continuationTools = options.getContinuationTools
      ? compactCandidates
      : this.getTools(defaultCompactModel);
    const registry = this.getToolRegistry();
    const modelTraceContext = createChildTraceContext(turnTraceContext, {
      attributes: {
        model: `${compactModel.providerId}/${compactModel.modelId}`,
        querySource: "compact",
      },
    });
    const prefixCount = countContextPrefixMessages(activeEntries);

    // 摘要请求按区间并发（上限 2）。每段请求都带 prefix：摘要模型需要工作目录、模式等前提，
    // 但只摘要本段区间内容，段外内容不会出现在这次请求里。
    const results: RuntimeModelTextResult[] = [];
    for (
      let offset = 0;
      offset < plan.ranges.length;
      offset += MAX_CONCURRENT_COMPACT_RANGE_REQUESTS
    ) {
      throwIfTurnAborted(options.abortSignal);
      const chunk = plan.ranges.slice(offset, offset + MAX_CONCURRENT_COMPACT_RANGE_REQUESTS);
      await Promise.all(
        chunk.map(async (range, chunkIndex) => {
          const rangeIndex = offset + chunkIndex;
          const suppliedSummary = hostCompactionSummary ?? range.summary;
          if (suppliedSummary !== undefined) {
            // PreCompact 钩子已给出折叠正文（单区间场景，多区间在上方已拒绝）：
            // 不再发模型摘要请求，usage 记 0，记账必须诚实。
            results[rangeIndex] = {
              finishReason: "stop",
              text: suppliedSummary,
              usage: { totalTokens: 0 },
            };
            return;
          }
          const entriesForSummary = [
            ...activeEntries.slice(0, prefixCount),
            ...activeEntries.slice(range.startIndex, range.endIndex + 1),
          ];
          // 走到这里说明本段没有宿主/模型摘要可用，必须由摘要模型生成；
          // 直接生成说明，避免外层的 undefined 分支留下非空断言。
          const compactPrompt = buildCompactPrompt(effectiveCustomInstructions);
          const prepared = prepareRuntimeProviderRequest(this, {
            model: compactModel,
            tools: compactCandidates,
            registry,
            toolExposureEntries: activeEntries,
            entries: entriesForSummary,
            prompt: compactPrompt,
            applyCacheControl: true,
            skipCacheWrite: true,
          });
          results[rangeIndex] = await runCompactSummaryModelRequest({
            logger: this.logger,
            model: compactModel,
            request: {
              abortSignal: options.abortSignal,
              maxOutputTokens: capCompactSummaryMaxOutputTokens(compactModel),
              messages: prepared.request.messages,
              metadata: traceContextToLogContext(modelTraceContext),
              modelCall: {
                attributes: {
                  compactionOuterAttempt: 1,
                  compactionTrigger: trigger,
                },
                // ModelApiCustomAttributes 是受控白名单，不能为「第几段区间」新增键；
                // 用 logicalCallId 区分同一 operation 下的不同区间请求，保持可观测且不改契约。
                logicalCallId: `${compactTimeline.operationId}:range_${rangeIndex + 1}`,
                operation: "context_compaction",
                operationId: compactTimeline.operationId,
              },
              statusSink: this.createModelStatusSink(modelTraceContext, events),
              preserveProviderStreamBoundaries: true,
              traceContext: modelTraceContext,
              tools: prepared.request.tools,
              toolSearchEnabled: prepared.request.toolSearchEnabled,
            },
          });
        }),
      );
    }
    // 模型可能在返回最后一个结果时才收到取消；没有文件补回时不能依赖 I/O 替我们检查。
    throwIfTurnAborted(options.abortSignal);

    const retrievalToolsAvailable =
      continuationTools.some((tool) => tool.name === SEARCH_CONTEXT_TOOL_NAME) &&
      continuationTools.some((tool) => tool.name === DECOMPRESS_CONTEXT_TOOL_NAME);
    // 本操作所有区间共享同一份「折叠前已发现工具」：它描述的是折叠前上下文，
    // 不是每段区间的局部状态。
    const discoveredTools = collectDiscoveredTools(activeEntries);
    // 文件补回与 plan 引用和摘要产出并行：它们读的是「折叠后仍保留的尾部」里引用的文件，
    // 与 legacy 路径同口径（preservedEntries 换成最后一个区间之后的保留段）。
    const tailPreservedEntries = activeEntries.slice(
      plan.ranges[plan.ranges.length - 1]!.endIndex + 1,
    );
    const [planFileReferenceEntry, fileRestore] = await Promise.all([
      this.fileSystemPort
        ? readApprovedPlanFileReferenceEntry({
            abortSignal: options.abortSignal,
            fileSystemPort: this.fileSystemPort,
            sessionId: this.sessionId,
            traceContext: modelTraceContext,
            workspaceRoot: this.workspaceRoot,
          })
        : undefined,
      restorePostCompactFiles(this, {
        abortSignal: options.abortSignal,
        model: defaultCompactModel,
        preservedEntries: tailPreservedEntries,
        traceContext: modelTraceContext,
      }),
    ]);

    const summaryRecords: PersistedCompactSummaryRecord[] = [];
    const summaryEntries: RuntimeMessageEntry[] = [];
    const boundaries: CompactBoundaryPayload[] = [];
    for (let rangeIndex = 0; rangeIndex < plan.ranges.length; rangeIndex += 1) {
      const range = plan.ranges[rangeIndex]!;
      const result = results[rangeIndex]!;
      const summaryText = formatCompactSummaryOrThrow(this, result);
      // 每段摘要都是一次真实的模型调用，必须各自落一条 ModelComplete，
      // 否则 telemetry/transcript 只能看到 CompactBoundary 而看不到对应请求。
      if (range.summary === undefined && hostCompactionSummary === undefined) {
        const modelCompleteEvent = this.createEvent(
          SessionEventType.ModelComplete,
          {
            content: summaryText,
            stopReason: result.finishReason,
            usage: result.usage,
            querySource: "compact",
            toolCallCount: 0,
          },
          modelTraceContext,
        );
        await this.appendEvent(modelCompleteEvent, modelTraceContext);
        events.push(modelCompleteEvent);
      }
      const summaryMessageId = createMessageId();
      const content = buildCompactSummaryMessage(summaryText, {
        // 区间压缩保留段为空（未选中的历史本身就是保留段），不需要「原文比摘要新」提示。
        preservedMessagesKept: false,
        retrievalToolsAvailable,
        suppressFollowup: true,
      });
      const discovery = compactDiscoveryMetadata({
        boundaryId: createCompactBoundaryId(),
        preCompactDiscoveredTools: [...discoveredTools],
      });
      const boundary = buildManualCompactBoundary({
        ...discovery,
        autoCompactThreshold: options.autoCompactThreshold,
        compactReason,
        customInstructions: effectiveCustomInstructions,
        lastSummarizedMessageId: range.endMessageId,
        phase,
        postCompactTokenCount: 0,
        preCompactTokenCount,
        summarizedMessageCount: range.endIndex - range.startIndex + 1,
        summaryMessageId,
        traceContext: turnTraceContext,
        trigger,
        // 边界在摘要完成时构建，真实折叠后体积要等所有区间替换完才能算；
        // 这里先占位 0，真实值写进 operation 级 timeline。
        truePostCompactTokenCount: 0,
        willRetriggerNextTurn: undefined,
      });
      const compactRange: CompactRangeMetadata = {
        rangeId: `range_${rangeIndex + 1}`,
        startMessageId: range.startMessageId,
        endMessageId: range.endMessageId,
        summaryMessageId,
      };
      const hierarchy = buildContextFold(activeEntries.slice(range.startIndex, range.endIndex + 1));
      summaryRecords.push({
        hierarchy,
        summaryMessageId,
        content,
        summaryText,
        boundary,
        compactRange,
        compactFormat: "ranges-v1",
        cacheUsage: toCompactCacheUsage(result.usage),
      });
      summaryEntries.push({
        messageId: summaryMessageId,
        message: { role: "user", content },
        metadata: {
          ...legacySyntheticRuntimeMetadata(),
          compactBoundary: discovery,
          compactHierarchy: hierarchy,
        },
      });
      boundaries.push(boundary);
    }

    const retainedEntries = buildPostCompactRuntimeEntriesForRanges(
      activeEntries,
      plan.ranges.map((range, rangeIndex) => ({
        ...range,
        summaryEntry: summaryEntries[rangeIndex]!,
      })),
    );
    // 未选区间的公告仍然有效；按保留视图补缺，不能每次再发整份目录破坏压缩收益。
    const planModeReminderBody = buildRuntimeModeReminderBody(
      retainedEntries,
      this.getMode(),
      this.getPlanEnabled(),
    );
    const toolAnnouncement = buildToolSearchAnnouncement(
      {
        model: defaultCompactModel,
        mode: this.config.toolSearch?.mode,
        tools: continuationTools,
        registry,
        entries: retainedEntries,
      },
      discoveredTools,
    );
    const agentListingEntry = collectRuntimeAgentListing(
      this,
      retainedEntries,
      options.agentListingTools ?? continuationTools,
    );
    const skillsListingEntry = collectSkillsListing(this, retainedEntries);
    const reminders: RuntimeMessageEntry[] = [
      // 顺序与 legacy 一致：文件恢复 → plan 文件 → plan 提醒 → ToolSearch 公告 → agent/skill。
      ...fileRestore.entries,
      ...(planFileReferenceEntry ? [planFileReferenceEntry] : []),
      ...(planModeReminderBody
        ? [systemReminderAttachmentEntry("runtime_mode", planModeReminderBody)]
        : []),
      ...(toolAnnouncement ? [toolAnnouncement] : []),
      ...(agentListingEntry ? [agentListingEntry] : []),
      ...(skillsListingEntry ? [skillsListingEntry] : []),
      ...restateContextAfterCompact(this, activeEntries, retainedEntries),
    ];

    const postCompactEntries = buildPostCompactRuntimeEntriesForRanges(
      activeEntries,
      plan.ranges.map((range, rangeIndex) => ({
        startIndex: range.startIndex,
        endIndex: range.endIndex,
        summaryEntry: summaryEntries[rangeIndex]!,
      })),
      reminders,
    );
    const truePostCompactTokenCount = estimateRuntimeEntryTokens(postCompactEntries, {
      useMidConversationSystem: continuationMcs,
    });
    const skipped = await skipNonShrinkingCompact(this, {
      timeline: compactTimeline,
      entries: activeEntries,
      postTokens: truePostCompactTokenCount,
      model: defaultCompactModel,
      force: submittedSummaries,
      autoCompactThreshold: options.autoCompactThreshold,
      abortSignal: options.abortSignal,
      traceContext: turnTraceContext,
      events,
    });
    if (skipped) return skipped;
    // boundary 在摘要完成时只能先占位 0；真实折叠后体积要等所有区间替换完才能算，
    // 这里把操作级真实值补进每个 boundary（落盘 part 与事件都用补完后的对象）。
    for (const boundary of boundaries) {
      boundary.postCompactTokenCount = truePostCompactTokenCount;
      boundary.truePostCompactTokenCount = truePostCompactTokenCount;
    }

    // 摘要完成后仍有文件读取与事件写入等 await；提交前再次检查，取消不得留下新摘要。
    throwIfTurnAborted(options.abortSignal);
    // 原子落盘：所有区间摘要 + 操作级提醒一次提交。任一段请求失败都在此之前抛出，
    // 因此不会出现「一半区间已替换、一半还是原文」的持久化中间态。
    await persistCompactSummaries.call(this, summaryRecords, {
      model: compactModel,
      operationId: compactTimeline.operationId,
      postCompactReminderEntries: reminders,
      traceContext: turnTraceContext,
    });
    compactCommitted = true;
    const lastRecord = summaryRecords[summaryRecords.length - 1]!;
    const lastRange = plan.ranges[plan.ranges.length - 1]!;
    // 区间折叠只替换选中的消息：尾部未选中的消息仍然活跃，冷恢复读到的最后一条就是它。
    // 只有指针指向被折掉的原文时才退回 summary，避免 live/cold 锚点分叉。
    const previousLatest = this.latestConversationMessageId;
    const retainedAnchor =
      previousLatest &&
      postCompactEntries.some(
        (entry) => entry.kind !== "attachment" && entry.messageId === previousLatest,
      )
        ? previousLatest
        : undefined;
    // 提交后先同步更新 Runtime，再做可失败的事件 I/O：磁盘与活跃历史必须始终同向收敛。
    applyOrDeferCommittedCompactState(this, {
      ...(retainedAnchor ? { anchorMessageId: retainedAnchor } : {}),
      entries: postCompactEntries,
      preserveCanonicalPrefix: options.activeEntries !== undefined,
      readFileStateEntries: fileRestore.readFileStateEntries,
      summaryMessageId: lastRecord.summaryMessageId,
      tokenCount: truePostCompactTokenCount,
    });

    for (const boundary of boundaries) {
      const boundaryEvent = this.createEvent(
        SessionEventType.CompactBoundary,
        boundary,
        turnTraceContext,
      );
      await this.appendEvent(boundaryEvent, turnTraceContext);
      events.push(boundaryEvent);
    }
    await persistCompactTimelineEvent(
      this,
      SessionEventType.CompactCompleted,
      buildCompactTimelinePayload.call(this, compactTimeline, {
        ...(summaryOrigin ? { reason: COMPACT_SUMMARY_ORIGIN_PREFIX + summaryOrigin } : {}),
        boundaryId: lastRecord.boundary.boundaryId,
        endedAt: Date.now(),
        postCompactTokenCount: truePostCompactTokenCount,
        replace: true,
        status: CompactTimelineStatus.Completed,
        summaryMessageId: lastRecord.summaryMessageId,
        tailStartMessageId: lastRange.endMessageId,
        truePostCompactTokenCount,
      }),
      turnTraceContext,
      events,
    );

    // 与 legacy 一致：折叠落地后通知插件，并把 PostCompact 返回的 additionalContext
    // 注入消息历史（必须在 replaceMessages 之后，否则会被这次替换覆盖）。
    const postCompactHookResult = await this.runPostCompactHooks(
      {
        keptEntries: postCompactEntries.length,
        postCompactTokens: truePostCompactTokenCount,
        preCompactTokens: preCompactTokenCount,
        reason: compactReason,
        savedTokens: preCompactTokenCount - truePostCompactTokenCount,
        summaryChars: summaryRecords.reduce(
          (total, record) => total + record.summaryText.length,
          0,
        ),
        trigger,
      },
      turnTraceContext,
      options.abortSignal,
    );
    const postCompactHookEntry = this.injectHookAdditionalContextIntoMessageHistory(
      HookEventName.PostCompact,
      postCompactHookResult.additionalContexts,
    );
    // 提交后的后续步骤已全部成功，下一次请求不再需要重放这份提交。
    finalizeCommittedCompactApply(this);
    if (options.modelCompact) {
      options.modelCompact.slot.current = undefined;
      options.modelCompact.slot.consecutivePreparations = 0;
    }

    return {
      displayText: "Compacted",
      // auto/CompactNow 会用这份 entries 覆盖 turn request 状态；hook 提醒必须同时出现在返回值里。
      entries: postCompactHookEntry
        ? [...postCompactEntries, postCompactHookEntry]
        : postCompactEntries,
      outcome: "compacted",
      tokenCount: truePostCompactTokenCount,
    };
  } catch (error) {
    // bundle 已提交后，不能把事件/钩子错误误判为摘要失败；活跃状态已同步，原错误仍向上暴露。
    if (compactCommitted) {
      logCommittedCompactFailure(this, error, compactTimeline, turnTraceContext);
      throw error;
    }
    await finishCompactTimelineFailure.call(this, {
      abortSignal: options.abortSignal,
      attempt: 1,
      error,
      events,
      maxAttempts: undefined,
      timeline: compactTimeline,
      traceContext: turnTraceContext,
    });
    throw error;
  }
}
