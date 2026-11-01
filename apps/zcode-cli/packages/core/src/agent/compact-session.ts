import type {
  CompactBoundaryPayload,
  MessagePart,
  MessageId,
  MessageWithParts,
} from "@zcode/contracts";
import { invalidateRuntimeTokenUsage } from "./message-history.js";

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
    ...messages.slice(0, boundaryIndex).filter((message) => keptBeforeBoundaryIds.has(message.info.id)),
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
  const boundary = compactBoundaryFromMessage(messages[boundaryIndex]!);
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
