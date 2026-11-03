import type { CompactRangeInput, MessageId } from "@zcode/contracts";
import {
  countContextPrefixMessages,
  isRuntimeAttachmentEntry,
  type RuntimeMessageEntry,
} from "../agent/message-history.js";
import { groupByAssistantStartedRounds } from "../compact/rounds.js";
import { estimateRuntimeEntryTokens } from "../runtime/helpers/compact-selection.js";

/** 单次操作允许的最大区间数：上限来自 CompactRangeInput 的契约（max 16），这里再兜一层。 */
const MAX_COMPACT_RANGES = 16;

/** 规划后的区间，索引相对 activeEntries（不是 provider 投影）。 */
export interface PlannedCompactRange {
  startIndex: number;
  endIndex: number;
  startMessageId: MessageId;
  endMessageId: MessageId;
  summary?: string;
}

export type CompactRangePlan =
  | { ok: true; ranges: PlannedCompactRange[] }
  | { ok: false; reason: string; message: string };

function invalidRange(message: string): CompactRangePlan {
  return { ok: false, reason: "invalid_range", message };
}

function entryMessageId(entry: RuntimeMessageEntry | undefined): string | undefined {
  // attachment 没有对应的持久化消息行，不能作为区间端点；只映射真实的 message id。
  return entry && !isRuntimeAttachmentEntry(entry) ? entry.messageId : undefined;
}

function firstMessageIdInRange(
  entries: readonly RuntimeMessageEntry[],
  startIndex: number,
  endIndex: number,
): MessageId {
  for (let index = startIndex; index <= endIndex; index += 1) {
    const id = entryMessageId(entries[index]);
    if (id) return id as MessageId;
  }
  // 兜底：区间内没有可用 messageId 时仍给出稳定可读的标识，避免 undefined 流进 metadata。
  return `message_${startIndex}` as MessageId;
}

function lastMessageIdInRange(
  entries: readonly RuntimeMessageEntry[],
  startIndex: number,
  endIndex: number,
): MessageId {
  for (let index = endIndex; index >= startIndex; index -= 1) {
    const id = entryMessageId(entries[index]);
    if (id) return id as MessageId;
  }
  return `message_${endIndex}` as MessageId;
}

/**
 * runtime entry 是否带有摘要节点标记。
 *
 * 冷恢复的 isCompactPreservableSessionMessage 判定的是持久化消息：hidden / 含 compaction part /
 * assistant error。runtime entry 只承载 provider 可见内容，hidden 与 compaction part 不会出现在这里，
 * 摘要节点需要单独分组并验证身份；assistant 错误条目另行拒绝。
 */
function isFoldedCompactEntry(entry: RuntimeMessageEntry): boolean {
  return (
    entry.metadata?.compactBoundary !== undefined || entry.metadata?.retainedCompactSummary === true
  );
}

function isAssistantErrorEntry(entry: RuntimeMessageEntry): boolean {
  // 与 isCompactPreservableSessionMessage 的 `role === "assistant" && info.error` 对齐：
  // runtime 侧错误落在 message.isError 上；这类条目没有可摘要的正文，折进去会生成空摘要。
  return (
    !isRuntimeAttachmentEntry(entry) &&
    entry.message.role === "assistant" &&
    entry.message.isError === true
  );
}

/** 规划与建议共用同一组完整轮，避免建议出的端点在提交时被悄悄外扩。 */
function compactRoundGroups(activeEntries: readonly RuntimeMessageEntry[], prefixCount: number) {
  const roundGroups: RuntimeMessageEntry[][] = [];
  let ordinary: RuntimeMessageEntry[] = [];
  const flush = () => {
    roundGroups.push(
      ...groupByAssistantStartedRounds(
        ordinary,
        (entry) => (isRuntimeAttachmentEntry(entry) ? undefined : entry.message.role),
        (entry) => (isRuntimeAttachmentEntry(entry) ? undefined : entry.compactGroupKey),
      ),
    );
    ordinary = [];
  };
  for (const entry of activeEntries.slice(prefixCount)) {
    if (isFoldedCompactEntry(entry)) {
      flush();
      roundGroups.push([entry]);
    } else ordinary.push(entry);
  }
  flush();
  return roundGroups;
}

/** 仅提供可选建议：保留首轮和最近两轮，按折点从后向前选大块，减少缓存重付范围。 */
export function suggestCompactRanges(
  activeEntries: readonly RuntimeMessageEntry[],
  input: { minTokens: number; maxRanges: number },
) {
  const groups = compactRoundGroups(activeEntries, countContextPrefixMessages(activeEntries));
  const suggestions: Array<{
    startMessageId: string;
    endMessageId: string;
    estimatedTokens: number;
  }> = [];
  for (let index = groups.length - 3; index > 0 && suggestions.length < input.maxRanges; index--) {
    const group = groups[index]!;
    if (
      group.some(
        (entry) =>
          isAssistantErrorEntry(entry) ||
          (isFoldedCompactEntry(entry) &&
            (!entryMessageId(entry) || !entry.metadata?.compactBoundary)),
      )
    )
      continue;
    const ids = group.flatMap((entry) => {
      const id = entryMessageId(entry);
      return id ? [id] : [];
    });
    if (!ids.length) continue;
    const estimatedTokens = estimateRuntimeEntryTokens(group);
    if (estimatedTokens < input.minTokens) continue;
    suggestions.push({ startMessageId: ids[0]!, endMessageId: ids.at(-1)!, estimatedTokens });
  }
  return suggestions;
}

/**
 * 把用户选择的消息区间规划成可执行的折叠区间。
 *
 * 规则（顺序敏感）：
 * 1. 空/超量/空 id 直接拒绝；
 * 2. 用 messageId 索引定位区间端点，缺失 id 报 unknown_message_id；
 * 3. 端点必须落在 context prefix 之后、且 start <= end；
 * 4. 原始区间重叠先合并，再按 assistant 起始轮外扩（同一条持久化 assistant 拆出的多条 entry
 *    必须一起折，否则 tool 轮会被切成半截）；
 * 5. 有稳定身份的摘要作为独立轮递归折叠；assistant 错误仍拒绝；
 * 6. 外扩后重叠：原始区间之间本来就有未被选中的 gap 消息时拒绝，绝不静默扩大；
 * 7. 选中内容 token 估算必须 > 0。
 */
export function planCompactRanges(
  activeEntries: readonly RuntimeMessageEntry[],
  ranges: readonly CompactRangeInput[],
): CompactRangePlan {
  if (ranges.length === 0) {
    return invalidRange("No ranges were provided for selective compaction.");
  }
  if (ranges.length > MAX_COMPACT_RANGES) {
    return invalidRange(
      `At most ${MAX_COMPACT_RANGES} ranges can be compacted in one operation; received ${ranges.length}.`,
    );
  }
  for (const range of ranges) {
    if (!range.startMessageId?.trim() || !range.endMessageId?.trim()) {
      // 契约层 zod 已限制 min(1)，纯函数仍要能独立防住手写调用方。
      return invalidRange("Each compact range needs both startMessageId and endMessageId.");
    }
  }

  const messageIdIndex = new Map<string, number[]>();
  activeEntries.forEach((entry, index) => {
    const id = entryMessageId(entry);
    if (!id) return;
    const bucket = messageIdIndex.get(id);
    if (bucket) {
      bucket.push(index);
    } else {
      messageIdIndex.set(id, [index]);
    }
  });

  const missingIds: string[] = [];
  const requestedRanges: { startIndex: number; endIndex: number }[] = [];
  for (const range of ranges) {
    const startIndices = messageIdIndex.get(range.startMessageId);
    const endIndices = messageIdIndex.get(range.endMessageId);
    if (!startIndices || startIndices.length === 0) missingIds.push(range.startMessageId);
    if (!endIndices || endIndices.length === 0) missingIds.push(range.endMessageId);
    if (!startIndices || !endIndices) continue;
    // 同一条持久化 assistant 会拆成 assistant + tool 多条 entry（共享 messageId）：
    // 起点取最早、终点取最晚，保证区间包住整条持久化消息。
    requestedRanges.push({
      startIndex: Math.min(...startIndices),
      endIndex: Math.max(...endIndices),
    });
  }
  if (missingIds.length > 0) {
    const unique = [...new Set(missingIds)];
    return {
      ok: false,
      reason: "unknown_message_id",
      message: `Unknown message id(s) in compact ranges: ${unique.join(", ")}.`,
    };
  }

  const prefixCount = countContextPrefixMessages(activeEntries);
  for (const range of requestedRanges) {
    if (range.startIndex > range.endIndex) {
      return invalidRange(
        `Compact range start must not be after its end (${range.startIndex} > ${range.endIndex}).`,
      );
    }
    if (range.startIndex < prefixCount) {
      // prefix 是 system/提醒注入的上下文，折掉它会让摘要模型失去工作目录与模式前提。
      return invalidRange("Compact ranges cannot include the system context prefix.");
    }
  }

  // 原始区间按位置排序后合并重叠：用户可能把同一条消息写进两个区间，合并后再统一外扩。
  const sortedRequested = [...requestedRanges].sort(
    (left, right) => left.startIndex - right.startIndex || left.endIndex - right.endIndex,
  );
  const mergedOriginals: { startIndex: number; endIndex: number }[] = [];
  for (const range of sortedRequested) {
    const previous = mergedOriginals[mergedOriginals.length - 1];
    if (previous && range.startIndex <= previous.endIndex) {
      previous.endIndex = Math.max(previous.endIndex, range.endIndex);
      continue;
    }
    mergedOriginals.push({ startIndex: range.startIndex, endIndex: range.endIndex });
  }

  // 轮分组只针对 prefix 之后的历史；role/assistantId 回调与 compact-selection 的
  // runtimeEntryRole / runtimeEntryCompactGroupKey 同语义（attachment 不参与轮边界判定）。
  const roundGroups = compactRoundGroups(activeEntries, prefixCount);
  const roundStarts: number[] = [];
  const roundEnds: number[] = [];
  let roundCursor = prefixCount;
  for (const group of roundGroups) {
    roundStarts.push(roundCursor);
    roundCursor += group.length;
    roundEnds.push(roundCursor - 1);
  }
  const roundIndexFor = (index: number): number => {
    for (let roundIndex = 0; roundIndex < roundStarts.length; roundIndex += 1) {
      if (index >= roundStarts[roundIndex]! && index <= roundEnds[roundIndex]!) return roundIndex;
    }
    return -1;
  };

  // 外扩到轮边界：区间起点所在轮的整轮内容一起折，否则被切开的 tool 轮在摘要里会前后矛盾。
  const expandedRanges = mergedOriginals.map((range) => {
    const startRound = roundIndexFor(range.startIndex);
    const endRound = roundIndexFor(range.endIndex);
    return {
      startIndex: startRound >= 0 ? roundStarts[startRound]! : range.startIndex,
      endIndex: endRound >= 0 ? roundEnds[endRound]! : range.endIndex,
      originalStartIndex: range.startIndex,
      originalEndIndex: range.endIndex,
    };
  });

  // 旧摘要必须有持久化身份和边界才能递归引用；错误条目仍不可摘要。
  for (const range of expandedRanges) {
    for (let index = range.startIndex; index <= range.endIndex; index += 1) {
      const entry = activeEntries[index];
      if (!entry) continue;
      if (
        isFoldedCompactEntry(entry) &&
        (!entryMessageId(entry) || !entry.metadata?.compactBoundary)
      ) {
        return invalidRange(
          `Compact range ${firstMessageIdInRange(activeEntries, range.startIndex, range.endIndex)}..${lastMessageIdInRange(activeEntries, range.startIndex, range.endIndex)} already contains a folded summary or compact boundary.`,
        );
      }
      if (isAssistantErrorEntry(entry)) {
        return invalidRange(
          `Compact range ${firstMessageIdInRange(activeEntries, range.startIndex, range.endIndex)}..${lastMessageIdInRange(activeEntries, range.startIndex, range.endIndex)} contains an assistant error message that cannot be summarized.`,
        );
      }
    }
  }

  // 合并扩后的重叠区间。若两个原始区间之间本来就有未被选中的消息（gap），
  // 外扩会把用户没选的内容也折掉：宁可拒绝并列出会生效的区间，也不静默扩大范围。
  const planned: {
    startIndex: number;
    endIndex: number;
    originalStartIndex: number;
    originalEndIndex: number;
  }[] = [];
  for (const range of expandedRanges) {
    const previous = planned[planned.length - 1];
    if (!previous || range.startIndex > previous.endIndex) {
      planned.push({ ...range });
      continue;
    }
    const hasUnselectedGap =
      previous.originalEndIndex < range.originalStartIndex &&
      range.originalStartIndex - previous.originalEndIndex > 1;
    if (hasUnselectedGap) {
      const effectiveRanges = expandedRanges.map(
        (candidate) =>
          `${firstMessageIdInRange(activeEntries, candidate.startIndex, candidate.endIndex)}..${lastMessageIdInRange(activeEntries, candidate.startIndex, candidate.endIndex)}`,
      );
      return {
        ok: false,
        reason: "range_expansion_overlap",
        message: `Range expansion would also compact messages between the selected ranges. Effective ranges would be: ${effectiveRanges.join(", ")}.`,
      };
    }
    previous.endIndex = Math.max(previous.endIndex, range.endIndex);
    previous.originalEndIndex = Math.max(previous.originalEndIndex, range.originalEndIndex);
  }

  const result: PlannedCompactRange[] = planned.map((range) => ({
    startIndex: range.startIndex,
    endIndex: range.endIndex,
    // 端点消息 id 必须落在实际区间内：外扩后的起点可能是 attachment 或没有 id 的条目，
    // 此时向后/向前找区间内第一条/最后一条真实消息 id。
    startMessageId: firstMessageIdInRange(activeEntries, range.startIndex, range.endIndex),
    endMessageId: lastMessageIdInRange(activeEntries, range.startIndex, range.endIndex),
  }));

  const selectedEntries = result.flatMap((range) =>
    activeEntries.slice(range.startIndex, range.endIndex + 1),
  );
  if (estimateRuntimeEntryTokens(selectedEntries) <= 0) {
    return invalidRange("Selected compact ranges contain no compactable content.");
  }

  if (ranges.some((range) => range.summary !== undefined)) {
    // 主模型正文已经写好，不能把它套到外扩或合并后的另一段原文上。
    const summaries = new Map(
      ranges.map((range) => [
        JSON.stringify([range.startMessageId, range.endMessageId]),
        range.summary,
      ]),
    );
    if (
      ranges.length !== result.length ||
      summaries.size !== ranges.length ||
      result.some(
        (range) =>
          !summaries.get(JSON.stringify([range.startMessageId, range.endMessageId]))?.trim(),
      )
    )
      return invalidRange(
        `Submitted summaries must cover every range with exact whole-round endpoints and no overlaps. Effective ranges: ${result.map((range) => `${range.startMessageId}..${range.endMessageId}`).join(", ")}.`,
      );
    for (const range of result)
      range.summary = summaries
        .get(JSON.stringify([range.startMessageId, range.endMessageId]))!
        .trim();
  }
  return { ok: true, ranges: result };
}
