import type {
  CompactCacheUsage,
  CompactRangeMetadata,
  CompactionPartMetadata,
} from "@zcode/contracts";
import {
  CompactTrigger,
  CompactTimelineDisplay,
  CompactTimelineStatus,
  SessionEventType,
  createMessageId,
  createPartId,
  createRootTraceContext,
  traceContextToLogContext,
} from "../deps.js";
import type {
  CompactBoundaryPayload,
  CompactTimelinePayload,
  MessageId,
  MessageWithParts,
  Model,
  PartId,
  SessionEvent,
  TraceContext,
} from "../deps.js";
import {
  defaultCompactPhaseForTrigger,
  defaultCompactReasonForTrigger,
  compactFailureReasonFromError,
  isTurnCancellationError,
} from "../helpers/index.js";
import type { CompactTimelineContext } from "../types.js";
import type { AgentRuntimeInternal } from "../internal.js";
import type { RuntimeMessageEntry } from "../../agent/message-history.js";
import {
  buildRuntimeReminderMessage,
  removeRuntimePersistenceMessagesBestEffort,
  resolvePersistedReminderModel,
} from "./runtime-reminder-persistence.js";

export function buildCompactTimelinePayload(
  this: AgentRuntimeInternal,
  timeline: CompactTimelineContext,
  update: {
    attempt?: number;
    boundaryId?: string;
    endedAt?: number;
    maxAttempts?: number;
    postCompactTokenCount?: number;
    reason?: string;
    replace?: boolean;
    status: CompactTimelineStatus;
    summaryMessageId?: MessageId;
    tailStartMessageId?: MessageId;
    truePostCompactTokenCount?: number;
  },
): CompactTimelinePayload {
  const payload: CompactTimelinePayload = {
    operationId: timeline.operationId,
    messageId: timeline.messageId,
    partId: timeline.partId,
    status: update.status,
    trigger: timeline.trigger,
    phase: timeline.phase,
    compactReason: timeline.compactReason,
    display: CompactTimelineDisplay.Separator,
    preCompactTokenCount: timeline.preCompactTokenCount,
    sourceCommandId: timeline.sourceCommandId,
    startedAt: timeline.startedAt,
  };
  if (update.replace !== undefined) payload.replace = update.replace;
  if (update.reason !== undefined) payload.reason = update.reason;
  if (update.attempt !== undefined) payload.attempt = update.attempt;
  if (update.maxAttempts !== undefined) payload.maxAttempts = update.maxAttempts;
  if (update.boundaryId !== undefined) payload.boundaryId = update.boundaryId;
  if (update.summaryMessageId !== undefined) payload.summaryMessageId = update.summaryMessageId;
  if (update.tailStartMessageId !== undefined) {
    payload.tailStartMessageId = update.tailStartMessageId;
  }
  if (update.postCompactTokenCount !== undefined) {
    payload.postCompactTokenCount = update.postCompactTokenCount;
  }
  if (update.truePostCompactTokenCount !== undefined) {
    payload.truePostCompactTokenCount = update.truePostCompactTokenCount;
  }
  if (update.endedAt !== undefined) payload.endedAt = update.endedAt;
  return payload;
}

export async function persistCompactTimeline(
  this: AgentRuntimeInternal,
  payload: CompactTimelinePayload,
  traceContext: TraceContext,
): Promise<void> {
  if (!this.sessionStore) return;

  const created = payload.startedAt ?? Date.now();
  await this.persistAssistantTimelinePartForSession({
    sessionId: this.sessionId,
    messageID: payload.messageId,
    partID: compactTimelinePartId(payload),
    created,
    completed: payload.endedAt,
    finish: payload.status,
    timeline: {
      timelineType: "context_compaction",
      display: payload.display,
      status: payload.status,
      operationId: payload.operationId,
      sourceCommandId: payload.sourceCommandId,
      trigger: payload.trigger,
      phase: payload.phase,
      compactReason: payload.compactReason,
      boundaryId: payload.boundaryId,
      summaryMessageId: payload.summaryMessageId,
      preCompactTokenCount: payload.preCompactTokenCount,
      postCompactTokenCount: payload.postCompactTokenCount,
      truePostCompactTokenCount: payload.truePostCompactTokenCount,
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
      reason: payload.reason,
      time: {
        start: payload.startedAt,
        end: payload.endedAt,
      },
    },
    traceContext,
  });
  await this.persistPart(
    {
      id: payload.partId ?? createPartId(),
      sessionID: this.sessionId,
      messageID: payload.messageId,
      type: "compaction",
      auto: payload.trigger === CompactTrigger.Auto,
      trigger: payload.trigger,
      phase: payload.phase,
      compactReason: payload.compactReason,
      operationId: payload.operationId,
      timelineStatus: payload.status,
      timelineDisplay: payload.display,
      replace: payload.replace,
      reason: payload.reason,
      attempt: payload.attempt,
      maxAttempts: payload.maxAttempts,
      boundaryId: payload.boundaryId,
      summaryMessageId: payload.summaryMessageId,
      tail_start_id: payload.tailStartMessageId,
      preCompactTokenCount: payload.preCompactTokenCount,
      postCompactTokenCount: payload.postCompactTokenCount,
      truePostCompactTokenCount: payload.truePostCompactTokenCount,
      time: {
        start: payload.startedAt,
        end: payload.endedAt,
      },
    },
    traceContext,
  );
}

function compactTimelinePartId(payload: CompactTimelinePayload): PartId {
  return createPartId(`${String(payload.partId ?? payload.operationId)}_timeline`);
}

export async function finishCompactTimelineFailure(
  this: AgentRuntimeInternal,
  options: {
    abortSignal?: AbortSignal;
    attempt?: number;
    error: unknown;
    events: SessionEvent[];
    maxAttempts?: number;
    timeline: CompactTimelineContext;
    traceContext: TraceContext;
  },
): Promise<void> {
  const status = isTurnCancellationError(options.error, options.abortSignal)
    ? CompactTimelineStatus.Interrupted
    : CompactTimelineStatus.Failed;
  const payload = this.buildCompactTimelinePayload(options.timeline, {
    attempt: options.attempt,
    endedAt: Date.now(),
    maxAttempts: options.maxAttempts,
    reason: compactFailureReasonFromError(options.error),
    replace: true,
    status,
  });

  try {
    await this.persistCompactTimeline(payload, options.traceContext);
    const event = this.createEvent(SessionEventType.CompactFailed, payload, options.traceContext);
    await this.appendEvent(event, options.traceContext);
    options.events.push(event);
  } catch (timelineError) {
    this.logger?.warn("Compact timeline failure state could not be persisted", {
      ...traceContextToLogContext(options.traceContext),
      errorMessage: timelineError instanceof Error ? timelineError.message : String(timelineError),
      event: "compact.timeline.persist_failed",
      module: "core.runtime",
      status: "failed",
    });
  }
}

export async function recoverInterruptedCompactTimelines(
  this: AgentRuntimeInternal,
  messages: MessageWithParts[],
  traceContext: TraceContext,
): Promise<number> {
  if (!this.sessionStore) return 0;

  const boundaryByOperationId = new Map<string, CompactBoundaryPayload>();
  for (const message of messages) {
    for (const part of message.parts) {
      if (part.type !== "compaction" || !part.operationId || !part.compactBoundary) continue;
      boundaryByOperationId.set(part.operationId, part.compactBoundary);
    }
  }

  let recovered = 0;
  for (const message of messages) {
    for (const part of message.parts) {
      if (
        part.type !== "compaction" ||
        !isRecoverableRunningCompactTimelineStatus(part.timelineStatus) ||
        !part.operationId
      ) {
        continue;
      }

      const boundary = boundaryByOperationId.get(part.operationId);
      const status = boundary ? CompactTimelineStatus.Completed : CompactTimelineStatus.Interrupted;
      const timeline: CompactTimelineContext = {
        operationId: part.operationId,
        messageId: part.messageID,
        partId: part.id,
        trigger: part.trigger ?? CompactTrigger.Manual,
        phase:
          part.phase ??
          boundary?.phase ??
          defaultCompactPhaseForTrigger(part.trigger ?? CompactTrigger.Manual),
        compactReason:
          part.compactReason ??
          boundary?.compactReason ??
          defaultCompactReasonForTrigger(part.trigger ?? CompactTrigger.Manual),
        startedAt: part.time?.start ?? message.info.time.created,
        preCompactTokenCount: part.preCompactTokenCount,
      };
      const payload = this.buildCompactTimelinePayload(timeline, {
        attempt: part.attempt,
        boundaryId: boundary?.boundaryId,
        endedAt: Date.now(),
        maxAttempts: part.maxAttempts,
        postCompactTokenCount: boundary?.postCompactTokenCount,
        replace: true,
        status,
        summaryMessageId: boundary?.summaryMessageIds[0],
        tailStartMessageId: boundary?.lastSummarizedMessageId,
        truePostCompactTokenCount: boundary?.truePostCompactTokenCount,
      });
      await this.persistCompactTimeline(payload, traceContext);
      Object.assign(part, {
        timelineStatus: payload.status,
        phase: payload.phase,
        compactReason: payload.compactReason,
        replace: payload.replace,
        attempt: payload.attempt,
        maxAttempts: payload.maxAttempts,
        boundaryId: payload.boundaryId,
        summaryMessageId: payload.summaryMessageId,
        tail_start_id: payload.tailStartMessageId,
        postCompactTokenCount: payload.postCompactTokenCount,
        truePostCompactTokenCount: payload.truePostCompactTokenCount,
        time: {
          start: payload.startedAt,
          end: payload.endedAt,
        },
      });
      recovered += 1;
    }
  }

  return recovered;
}

function isRecoverableRunningCompactTimelineStatus(
  status: CompactTimelineStatus | undefined,
): boolean {
  // 自动 compact retry 会把同一个 timeline 持久化成 retrying；
  // 进程在 retry 间隔退出时，resume 必须把它和 started 一样收敛为 interrupted/completed。
  return status === CompactTimelineStatus.Started || status === CompactTimelineStatus.Retrying;
}

export async function persistCompactSummary(
  this: AgentRuntimeInternal,
  messageID: MessageId,
  content: string,
  summary: string,
  compactBoundary: CompactBoundaryPayload,
  traceContext: TraceContext,
  options?: {
    model?: Model;
    operationId?: string;
    leadingReminderEntries?: readonly RuntimeMessageEntry[];
    postCompactReminderEntries?: readonly RuntimeMessageEntry[];
    /**
     * 增量折叠保留下来的上一代摘要正文。按「新摘要之前的独立消息」落盘，
     * 冷恢复时按 compactRetainedMessageIds 放回，保证重启前后上下文一致。
     */
    retainedSummaries?: readonly string[];
    /**
     * 这次折叠摘要请求的 provider usage。缺省表示没拿到数据（旧调用方或 provider
     * 未上报），此时不写 metadata，读侧按「未知」降级而不是显示 0。
     */
    cacheUsage?: CompactCacheUsage;
    /**
     * 被本次折叠并进新摘要的更早层 boundaryId（旧→新）。写进 compaction part 的
     * metadata，DecompressContext tier="summary" 据此把「摘要消息已不在」的旧 boundary
     * 解析到覆盖它的最新摘要；仅被保留、没被重写的层不得出现在这里。
     */
    coversBoundaryIds?: readonly string[];
    retainedSummaryMessageIds?: readonly MessageId[];
    hierarchy?: import("@zcode/contracts/context-memory").ContextFoldMetadata;
  },
): Promise<void> {
  if (!this.sessionStore) return;

  const created = Date.now();
  const recordOptions = { created, model: options?.model };
  const leading = buildReminderRecords(this, options?.leadingReminderEntries, recordOptions);
  const retained = (options?.retainedSummaries ?? []).map((text) =>
    buildRetainedSummaryRecord(this, text, recordOptions),
  );
  const coversBoundaryIds = normalizeCoversBoundaryIds(options?.coversBoundaryIds);
  const attachments = buildReminderRecords(
    this,
    options?.postCompactReminderEntries,
    recordOptions,
  );
  // boundary 的 strict payload 不承载展示型计量；折叠开销跟着 compaction part 的
  // metadata 一起落盘，冷恢复时原样保留，CompactStatus 按 boundaryId 回收。
  const compactionMetadata: CompactionPartMetadata = {
    ...(leading.length > 0
      ? { compactLeadingMessageIds: leading.map((record) => record.info.id) }
      : {}),
    ...(retained.length > 0
      ? {
          compactRetainedMessageIds: [
            ...(options?.retainedSummaryMessageIds ?? []),
            ...retained.map((record) => record.info.id),
          ],
        }
      : {}),
    ...(options?.retainedSummaryMessageIds?.length && retained.length === 0
      ? { compactRetainedMessageIds: [...options.retainedSummaryMessageIds] }
      : {}),
    ...(options?.hierarchy ? { hierarchy: options.hierarchy } : {}),
    ...(options?.cacheUsage ? { cacheUsage: options.cacheUsage } : {}),
    ...(coversBoundaryIds.length > 0 ? { coversBoundaryIds } : {}),
  };
  const summaryRecord: MessageWithParts = {
    info: {
      id: messageID,
      sessionID: this.sessionId,
      role: "user",
      time: {
        created,
      },
      summary: {
        title: "Compact summary",
        body: summary,
        diffs: [],
      },
      agent: this.config.agentName ?? "zcode-agent",
      modelSelection: resolvePersistedReminderModel(this, options?.model),
      semantics: {
        origin: "agent_runtime",
        kind: "compact_summary",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      system: this.config.systemPrompt,
    },
    parts: [
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "text",
        text: content,
        synthetic: true,
        time: {
          start: created,
          end: created,
        },
      },
      {
        id: createPartId(),
        sessionID: this.sessionId,
        messageID,
        type: "compaction",
        auto: compactBoundary.trigger === "auto",
        trigger: compactBoundary.trigger,
        phase: compactBoundary.phase,
        compactReason: compactBoundary.compactReason,
        tail_start_id: compactBoundary.lastSummarizedMessageId,
        compactBoundary,
        operationId: options?.operationId,
        ...(Object.keys(compactionMetadata).length > 0 ? { metadata: compactionMetadata } : {}),
      },
    ],
  };
  // 存储顺序与 live 一致：请求前公告 → 旧摘要（增量折叠保留）→ summary → compaction 附件。
  const records = [...leading, ...retained, summaryRecord, ...attachments];
  if (this.sessionStore.commitMessageBundle) {
    await this.sessionStore.commitMessageBundle({ sessionID: this.sessionId, messages: records });
    this.logger?.debug("Compact bundle persisted", {
      ...traceContextToLogContext(traceContext),
      event: "session.compact_bundle.persisted",
      messageCount: records.length,
      module: "core.runtime",
      status: "completed",
    });
    return;
  }
  // 没有事务入口的 store 逐条写入；任一步失败都尽力删除已写入的记录。
  const persistedMessageIds: MessageId[] = [];
  try {
    for (const record of records) {
      persistedMessageIds.push(record.info.id);
      await this.persistMessage(record.info, traceContext);
      for (const part of record.parts) await this.persistPart(part, traceContext);
    }
  } catch (error) {
    await removeRuntimePersistenceMessagesBestEffort.call(this, persistedMessageIds, traceContext);
    throw error;
  }
}

/**
 * 一次「选择性区间压缩」里单段区间的落盘输入。
 *
 * 与 persistCompactSummary 的入参同源，只是把 boundary/cacheUsage/compactRange 打包成一条记录：
 * 每段区间各生成一条 summary 消息（text part + compaction part），N 段共享同一个 operationId，
 * 但各自有独立的 boundaryId / summaryMessageId / tail_start_id。
 */
export interface PersistedCompactSummaryRecord {
  hierarchy?: import("@zcode/contracts/context-memory").ContextFoldMetadata;
  summaryMessageId: MessageId;
  /** 落进 text part 的展示正文（已含 "This session is being continued" 等续跑提示）。 */
  content: string;
  /**
   * 格式化后的摘要正文，落进 info.summary.body 供 UI/冷恢复展示。
   * boundary 不承载摘要正文，所以这里仍要保留，不能只依赖 content。
   */
  summaryText: string;
  boundary: CompactBoundaryPayload;
  /** ranges-v1 的区间身份：冷恢复据此把摘要消息映射回它替换掉的原始区间。 */
  compactRange?: CompactRangeMetadata;
  compactFormat?: "ranges-v1";
  /** 该段摘要请求的 provider 计量；缺省表示未上报，不能写成 0。 */
  cacheUsage?: CompactCacheUsage;
}

/**
 * 选择性区间压缩的原子落盘：N 段区间摘要 + 本次操作级提醒一次提交。
 *
 * 为什么必须单次提交（而不是逐段调用 persistCompactSummary）：
 * - 冷恢复按 compaction part 重写消息历史，部分区间落盘会看到「摘要已替换、边界未写」的中间态；
 * - 每段一条 summary 消息 + 一条 compaction part 是同一个逻辑操作，拆开提交会产生
 *   N 次可观察的部分成功，失败回滚也只能覆盖最后一次；
 * - 操作级提醒（模式/工具/技能名单）对所有区间只应出现一份，追加在所有摘要之后。
 */
export async function persistCompactSummaries(
  this: AgentRuntimeInternal,
  records: readonly PersistedCompactSummaryRecord[],
  options?: {
    model?: Model;
    operationId?: string;
    postCompactReminderEntries?: readonly RuntimeMessageEntry[];
    traceContext?: TraceContext;
  },
): Promise<void> {
  if (!this.sessionStore) return;
  if (records.length === 0) return;

  const created = Date.now();
  const recordOptions = { created, model: options?.model };
  const messages: MessageWithParts[] = records.map((record) =>
    buildCompactRangeSummaryRecord(this, record, {
      ...recordOptions,
      operationId: options?.operationId,
    }),
  );
  // 操作级提醒只落一份，放在所有区间摘要之后：冷恢复按位置重放时它们位于最新摘要之后，
  // 与 live 上下文里 buildPostCompactRuntimeEntriesForRanges 的追加顺序一致。
  const attachments = buildReminderRecords(
    this,
    options?.postCompactReminderEntries,
    recordOptions,
  );
  messages.push(...attachments);

  if (this.sessionStore.commitMessageBundle) {
    await this.sessionStore.commitMessageBundle({ sessionID: this.sessionId, messages });
    this.logger?.debug("Compact range bundle persisted", {
      ...traceContextToLogContext(resolvePersistTraceContext(this, options?.traceContext)),
      event: "session.compact_range_bundle.persisted",
      messageCount: messages.length,
      module: "core.runtime",
      status: "completed",
    });
    return;
  }

  // 没有事务入口的 store 逐条写入；任一步失败都尽力删除已写入的记录，避免半套区间摘要留在库里。
  const traceContext = resolvePersistTraceContext(this, options?.traceContext);
  const persistedMessageIds: MessageId[] = [];
  try {
    for (const record of messages) {
      persistedMessageIds.push(record.info.id);
      await this.persistMessage(record.info, traceContext);
      for (const part of record.parts) await this.persistPart(part, traceContext);
    }
  } catch (error) {
    await removeRuntimePersistenceMessagesBestEffort.call(this, persistedMessageIds, traceContext);
    throw error;
  }
}

/**
 * 后台/测试路径可能没有 turn trace context，但持久化仍需要可观测的 traceId：
 * 用独立 root trace 记录，而不是因为缺少上下文就静默跳过落盘。
 */
function resolvePersistTraceContext(
  runtime: AgentRuntimeInternal,
  traceContext: TraceContext | undefined,
): TraceContext {
  return (
    traceContext ??
    createRootTraceContext({
      sessionId: runtime.sessionId,
      attributes: { querySource: "compact_persist" },
    })
  );
}

/**
 * 单段区间摘要消息：形状与 persistCompactSummary 的 summaryRecord 一致，
 * 额外把 compactRange / compactFormat 写进 compaction part 的 metadata（契约已支持）。
 */
function buildCompactRangeSummaryRecord(
  runtime: AgentRuntimeInternal,
  record: PersistedCompactSummaryRecord,
  options: { created: number; model?: Model; operationId?: string },
): MessageWithParts {
  const messageID = record.summaryMessageId;
  const boundary = record.boundary;
  const compactionMetadata: CompactionPartMetadata = {
    ...(record.hierarchy ? { hierarchy: record.hierarchy } : {}),
    ...(record.cacheUsage ? { cacheUsage: record.cacheUsage } : {}),
    ...(record.compactRange ? { compactRange: record.compactRange } : {}),
    ...(record.compactFormat ? { compactFormat: record.compactFormat } : {}),
  };
  return {
    info: {
      id: messageID,
      sessionID: runtime.sessionId,
      role: "user",
      time: { created: options.created },
      summary: {
        title: "Compact summary",
        body: record.summaryText,
        diffs: [],
      },
      agent: runtime.config.agentName ?? "zcode-agent",
      modelSelection: resolvePersistedReminderModel(runtime, options.model),
      semantics: {
        origin: "agent_runtime",
        kind: "compact_summary",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      system: runtime.config.systemPrompt,
    },
    parts: [
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID,
        type: "text",
        text: record.content,
        synthetic: true,
        time: { start: options.created, end: options.created },
      },
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID,
        type: "compaction",
        auto: boundary.trigger === "auto",
        trigger: boundary.trigger,
        phase: boundary.phase,
        compactReason: boundary.compactReason,
        tail_start_id: boundary.lastSummarizedMessageId,
        compactBoundary: boundary,
        operationId: options.operationId,
        ...(Object.keys(compactionMetadata).length > 0 ? { metadata: compactionMetadata } : {}),
      },
    ],
  };
}

/**
 * 父子映射的去重/清洗兜底：调用方已按旧→新排好并去重，这里只负责挡住空串
 * （损坏的旧元数据可能带回空 boundaryId，读侧会把它当一条永远解析不到的父链）。
 * 保持首次出现顺序，避免把「旧→新」写成任意顺序。
 */
function normalizeCoversBoundaryIds(ids: readonly string[] | undefined): string[] {
  if (!ids || ids.length === 0) return [];
  const picked: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    if (typeof id !== "string" || id.length === 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    picked.push(id);
  }
  return picked;
}

function buildReminderRecords(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[] | undefined,
  options: { created: number; model?: Model },
): MessageWithParts[] {
  return (entries ?? []).flatMap(
    (entry) => buildRuntimeReminderMessage(runtime, entry, options) ?? [],
  );
}

/**
 * 增量折叠保留的上一代摘要：与 summary 同一形状（role=user、semantics=compact_summary），
 * 只是正文来自更早一次折叠。它必须单独成消息落盘，否则冷恢复按 boundary 切片时会被切掉，
 * 运行时有、重启后没有。
 */
function buildRetainedSummaryRecord(
  runtime: AgentRuntimeInternal,
  text: string,
  options: { created: number; model?: Model },
): MessageWithParts {
  const messageID = createMessageId();
  return {
    info: {
      id: messageID,
      sessionID: runtime.sessionId,
      role: "user",
      time: { created: options.created },
      summary: { title: "Compact summary", body: text, diffs: [] },
      agent: runtime.config.agentName ?? "zcode-agent",
      modelSelection: resolvePersistedReminderModel(runtime, options.model),
      semantics: {
        origin: "agent_runtime",
        kind: "compact_summary",
        uiVisibility: "hidden",
        providerVisibility: "visible",
        transcriptVisibility: "hidden",
      },
      system: runtime.config.systemPrompt,
    },
    parts: [
      {
        id: createPartId(),
        sessionID: runtime.sessionId,
        messageID,
        type: "text",
        text,
        synthetic: true,
        time: { start: options.created, end: options.created },
      },
    ],
  };
}
