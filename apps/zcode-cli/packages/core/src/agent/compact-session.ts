import type {
  CompactBoundaryPayload,
  CompactRangeMetadata,
  Logger,
  MessagePart,
  MessageId,
  MessageWithParts,
} from "@zcode/contracts";
import { INTERRUPT_MARKER_SOURCE, invalidateRuntimeTokenUsage } from "./message-history.js";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import { syntheticSystemReminderAttachmentFromParts } from "./persisted-reminders/contract.js";

export function compactActiveSessionMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
  includePreservedSegment: boolean,
): MessageWithParts[] {
  // summary 之前的请求前公告与 summary 同一事务写在其之前，由 compaction part 声明后放回。
  // 增量折叠保留下来的旧摘要同样写在 boundary 之前，按 compactRetainedMessageIds 一起放回；
  // 少放回一层，重启后的上下文就比运行时少一段更早的摘要。
  const keptBeforeBoundaryIds = new Set([
    ...compactLeadingMessageIds(messages[boundaryIndex]!),
    ...compactRetainedMessageIds(messages[boundaryIndex]!),
  ]);
  const activeMessages = [
    ...messages
      .slice(0, boundaryIndex)
      .filter((message) => keptBeforeBoundaryIds.has(message.info.id)),
    ...messages.slice(boundaryIndex),
  ];
  if (!includePreservedSegment) return activeMessages;

  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
  const preservedMessages = compactPreservedSegmentMessages(messages, boundaryIndex);
  if (!boundary?.preservedSegment || preservedMessages.length === 0) {
    return activeMessages;
  }

  const anchorIndex = activeMessages.findIndex(
    (message) => message.info.id === boundary.preservedSegment?.anchorMessageId,
  );
  const insertIndex =
    anchorIndex >= 0 ? anchorIndex + 1 : activeMessages.indexOf(messages[boundaryIndex]!) + 1;
  return [
    ...activeMessages.slice(0, insertIndex),
    ...preservedMessages,
    ...activeMessages.slice(insertIndex),
  ];
}

export interface CompactSessionRewriteOptions {
  includePreservedSegment: boolean;
  logger?: Logger;
}

/**
 * 冷恢复时把持久化的折叠记录重放成 provider 可见的消息链。
 *
 * 旧 session 只有 legacy boundary（没有 per-range 记录），完全沿用
 * compactActiveSessionMessages 的「只认最后一个 boundary + 前缀裁剪」语义，
 * 保证历史数据逐字节等价。
 *
 * 含 ranges 记录的新 session 按 boundary 消息的物理顺序（即写入顺序）逐条重放：
 * range 记录把 [startMessageId, endMessageId] 原位替换为摘要消息；legacy 记录
 * 仍按它的前缀裁剪语义处理。任一条定位失败都暴露 SessionCorrupted，防止把
 * 未裁切历史当成已恢复上下文发给 provider；持久化原文不受影响。
 */
export function compactSessionMessages(
  messages: MessageWithParts[],
  options: CompactSessionRewriteOptions,
): MessageWithParts[] {
  const boundaryIndexes: number[] = [];
  for (let index = 0; index < messages.length; index++) {
    if (messages[index]!.parts.some(isActiveCompactionBoundaryPart)) {
      boundaryIndexes.push(index);
    }
  }
  const lastBoundaryIndex = boundaryIndexes[boundaryIndexes.length - 1];
  if (lastBoundaryIndex === undefined) return messages;

  const hasRangeRecord = boundaryIndexes.some(
    (index) => compactRangeFromMessage(messages[index]!) !== undefined,
  );
  if (!hasRangeRecord) {
    return compactActiveSessionMessages(
      messages,
      lastBoundaryIndex,
      options.includePreservedSegment,
    );
  }

  const rewritten = rewriteCompactedSessionMessages(messages, options);
  if (rewritten.messages) return rewritten.messages;

  // 根因：仅 warn 后返回全量历史让调用方误认为恢复成功，甚至重新超过上下文上限。
  // 纯重放层不具备修复损坏记录的能力；由现有恢复入口统一处理结构化错误。
  const failureMessage = "Failed to restore compacted session history";
  const context = { reason: rewritten.failure, boundaryCount: boundaryIndexes.length };
  const failure = createCoreError(CoreErrorType.SessionCorrupted, failureMessage, {
    context,
    retryable: false,
  });
  options.logger?.error(failureMessage, failure, {
    ...context,
    sessionId: messages[0]?.info.sessionID,
    errorType: CoreErrorType.SessionCorrupted,
  });
  throw failure;
}

interface CompactBoundaryRecord {
  message: MessageWithParts;
  range?: CompactRangeMetadata;
  hierarchy?: import("@zcode/contracts/context-memory").ContextFoldMetadata;
}

interface CompactRewriteResult {
  messages?: MessageWithParts[];
  failure?: string;
}

function rewriteCompactedSessionMessages(
  messages: MessageWithParts[],
  options: CompactSessionRewriteOptions,
): CompactRewriteResult {
  const records: CompactBoundaryRecord[] = [];
  for (const message of messages) {
    if (!message.parts.some(isActiveCompactionBoundaryPart)) continue;
    const part = message.parts.find((item) => item.type === "compaction" && item.compactBoundary);
    records.push({
      message,
      range: compactRangeFromMessage(message),
      hierarchy: part?.type === "compaction" ? part.metadata?.hierarchy : undefined,
    });
  }
  if (records.length === 0) return { messages };

  let working = messages;
  for (const record of records) {
    const next = record.range
      ? record.hierarchy
        ? applyHierarchicalCompactRecord(working, record.message, record.hierarchy)
        : applyCompactRangeRecord(working, record.message, record.range)
      : applyLegacyCompactRecord(working, record.message, options.includePreservedSegment);
    if (!next) {
      return {
        failure: record.range
          ? `range_relink_failed:${record.range.startMessageId}..${record.range.endMessageId}`
          : `legacy_boundary_missing:${record.message.info.id}`,
      };
    }
    working = next;
  }
  return { messages: working };
}

/** 递归节点按当前逻辑链的直接成员替换；不能再按摘要追加在日志末尾的物理位置推断。 */
function applyHierarchicalCompactRecord(
  messages: MessageWithParts[],
  summary: MessageWithParts,
  hierarchy: import("@zcode/contracts/context-memory").ContextFoldMetadata,
): MessageWithParts[] | undefined {
  const members = new Set(hierarchy.memberMessageIds);
  if (members.size === 0 || members.has(summary.info.id)) return undefined;
  const working = messages.filter((message) => message.info.id !== summary.info.id);
  const indexes = working.flatMap((message, index) =>
    members.has(message.info.id) ? [index] : [],
  );
  if (indexes.length !== members.size) return undefined;
  const first = indexes[0]!;
  const last = indexes.at(-1)!;
  const children = new Set(hierarchy.childBoundaryIds);
  for (let index = first; index <= last; index++) {
    const message = working[index]!;
    const boundary = compactBoundaryFromMessage(message);
    if (boundary && !children.has(boundary.boundaryId)) return undefined;
    if (
      !members.has(message.info.id) &&
      message.info.semantics?.providerVisibility !== "hidden" &&
      // 修复前的 hierarchy 没有收录 interrupt marker：当时 marker 的 live entry 丢掉了
      // 持久化 messageId，buildContextFold 不会把它算作成员，但冷侧水合后它仍是可见的
      // 普通 user 文本。只豁免这一种旧记录形状，不把 marker 注册成可恢复提醒。
      message.info.semantics?.source !== INTERRUPT_MARKER_SOURCE &&
      // todo 等附件在 live 中没有 messageId；必须复用水合的完整身份解析，不能按 kind 猜。
      !(message.info.role === "user" && syntheticSystemReminderAttachmentFromParts(message.parts))
    )
      return undefined;
  }
  return [...working.slice(0, first), summary, ...working.slice(last + 1)];
}

function applyLegacyCompactRecord(
  messages: MessageWithParts[],
  boundaryMessage: MessageWithParts,
  includePreservedSegment: boolean,
): MessageWithParts[] | undefined {
  const boundaryIndex = messages.findIndex(
    (message) => message.info.id === boundaryMessage.info.id,
  );
  if (boundaryIndex < 0) return undefined;

  const boundary = compactBoundaryFromMessage(boundaryMessage);
  // 保留段的消息本身不在 leading/retained 声明里，必须先从裁剪前的列表计算，再插回结果。
  const preservedMessages = includePreservedSegment
    ? preservedSegmentMessages(messages, boundary, boundaryIndex)
    : [];
  const keptBeforeBoundaryIds = new Set([
    ...compactLeadingMessageIds(boundaryMessage),
    ...compactRetainedMessageIds(boundaryMessage),
  ]);
  const activeMessages = [
    ...messages
      .slice(0, boundaryIndex)
      .filter((message) => keptBeforeBoundaryIds.has(message.info.id)),
    ...messages.slice(boundaryIndex),
  ];
  if (preservedMessages.length === 0) return activeMessages;

  const anchorIndex = activeMessages.findIndex(
    (message) => message.info.id === boundary?.preservedSegment?.anchorMessageId,
  );
  const insertIndex =
    anchorIndex >= 0 ? anchorIndex + 1 : activeMessages.indexOf(boundaryMessage) + 1;
  return [
    ...activeMessages.slice(0, insertIndex),
    ...preservedMessages,
    ...activeMessages.slice(insertIndex),
  ];
}

function applyCompactRangeRecord(
  messages: MessageWithParts[],
  boundaryMessage: MessageWithParts,
  range: CompactRangeMetadata,
): MessageWithParts[] | undefined {
  // 记录声明的摘要必须是 boundary 消息自身；不一致说明持久化数据被改写，不能猜。
  if (range.summaryMessageId !== undefined && range.summaryMessageId !== boundaryMessage.info.id) {
    return undefined;
  }
  const boundaryIndex = messages.findIndex(
    (message) => message.info.id === boundaryMessage.info.id,
  );
  if (boundaryIndex < 0) return undefined;

  const withoutSummary = [
    ...messages.slice(0, boundaryIndex),
    ...messages.slice(boundaryIndex + 1),
  ];
  const startIndex = withoutSummary.findIndex(
    (message) => message.info.id === range.startMessageId,
  );
  const endIndex = withoutSummary.findIndex((message) => message.info.id === range.endMessageId);
  if (startIndex < 0 || endIndex < startIndex) return undefined;

  // 区间内再出现 boundary 摘要说明区间嵌套/重叠或物理顺序错乱，整单回退而不是裁剪出错位链。
  for (let index = startIndex; index <= endIndex; index++) {
    if (withoutSummary[index]!.parts.some(isActiveCompactionBoundaryPart)) return undefined;
  }
  return [
    ...withoutSummary.slice(0, startIndex),
    boundaryMessage,
    ...withoutSummary.slice(endIndex + 1),
  ];
}

/** 读取 ranges 模式写入的 per-range 记录；旧数据或形状不对时按 legacy boundary 处理。 */
function compactRangeFromMessage(message: MessageWithParts): CompactRangeMetadata | undefined {
  for (const part of message.parts) {
    if (part.type !== "compaction" || !part.compactBoundary) continue;
    const range = part.metadata?.compactRange;
    if (
      range &&
      typeof range.startMessageId === "string" &&
      range.startMessageId.length > 0 &&
      typeof range.endMessageId === "string" &&
      range.endMessageId.length > 0
    ) {
      return range;
    }
  }
  return undefined;
}

/** 读取 compaction part 声明的请求前公告；磁盘数据形状不对时视为未声明。 */
function compactLeadingMessageIds(message: MessageWithParts): MessageId[] {
  return compactDeclaredMessageIds(message, "compactLeadingMessageIds");
}

/** 读取 compaction part 声明的增量折叠保留摘要（更早一层或多层的 summary 消息）。 */
function compactRetainedMessageIds(message: MessageWithParts): MessageId[] {
  return compactDeclaredMessageIds(message, "compactRetainedMessageIds");
}

function compactDeclaredMessageIds(message: MessageWithParts, key: string): MessageId[] {
  for (const part of message.parts) {
    if (part.type !== "compaction" || !part.compactBoundary) continue;
    const metadata = part.metadata as Record<string, unknown> | undefined;
    const ids = metadata?.[key];
    return Array.isArray(ids) && ids.every((id) => typeof id === "string")
      ? (ids as MessageId[])
      : [];
  }
  return [];
}

export function compactPreservedSegmentMessages(
  messages: MessageWithParts[],
  boundaryIndex: number,
): MessageWithParts[] {
  return preservedSegmentMessages(
    messages,
    compactBoundaryFromMessage(messages[boundaryIndex]!),
    boundaryIndex,
  );
}

function preservedSegmentMessages(
  messages: MessageWithParts[],
  boundary: CompactBoundaryPayload | undefined,
  boundaryIndex: number,
): MessageWithParts[] {
  const segment = boundary?.preservedSegment;
  if (!segment) return [];

  const headIndex = messages.findIndex((message) => message.info.id === segment.headMessageId);
  const tailIndex = messages.findIndex((message) => message.info.id === segment.tailMessageId);
  if (headIndex < 0 || tailIndex < headIndex || tailIndex >= boundaryIndex) {
    return [];
  }

  // 保留段可以落在上一次 compact 的保留段里，此时 head 在存储中位于上一次的
  // summary 之前，区间会跨过上一次的请求前公告。这些公告在压缩后的第一组，总被下一次
  // compact 总结，live 保留段里不会有，所以按各 summary 的声明跳过。
  const leadingIds = new Set(
    messages.flatMap((message) => [
      ...compactLeadingMessageIds(message),
      ...compactRetainedMessageIds(message),
    ]),
  );
  return messages
    .slice(headIndex, tailIndex + 1)
    .filter(
      (message) => isCompactPreservableSessionMessage(message) && !leadingIds.has(message.info.id),
    )
    .map(cloneCompactPreservedSessionMessage);
}

function cloneCompactPreservedSessionMessage(message: MessageWithParts): MessageWithParts {
  if (message.info.role !== "assistant") return message;
  return {
    ...message,
    info: {
      ...message.info,
      tokens: invalidateRuntimeTokenUsage(message.info.tokens),
    },
  };
}

export function compactBoundaryFromMessage(
  message: MessageWithParts,
): CompactBoundaryPayload | undefined {
  for (const part of message.parts) {
    if (part.type === "compaction" && part.compactBoundary) {
      return part.compactBoundary;
    }
  }
  return undefined;
}

export function isCompactPreservableSessionMessage(message: MessageWithParts): boolean {
  // UI timeline 也使用 assistant role，但不属于模型轮，不能让保留组的起点错位。
  if (message.info.semantics?.providerVisibility === "hidden") return false;
  if (message.parts.some((part) => part.type === "compaction")) {
    return false;
  }
  // synthetic/model-only 只描述输入身份和 UI 可见性；已选中的回信、任务结果和
  // attachment 没有进入 summary，冷恢复不能据此再次丢弃它们。
  if (message.info.role === "assistant" && message.info.error) {
    return false;
  }
  return message.info.role === "user" || message.info.role === "assistant";
}

export function isActiveCompactionBoundaryPart(part: MessagePart): boolean {
  return part.type === "compaction" && (Boolean(part.compactBoundary) || !part.timelineStatus);
}
