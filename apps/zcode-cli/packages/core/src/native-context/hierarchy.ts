import type { ContextFoldMetadata } from "@zcode/contracts/context-memory";
import type { MessageId } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../agent/message-history.js";
import { estimateRuntimeEntryTokens } from "../runtime/helpers/compact-selection.js";

const RETAINED_SUMMARY_RATIO = 0.15;
const MIN_RETAINED_SUMMARY_TOKENS = 4_000;
const MAX_RETAINED_SUMMARY_TOKENS = 32_000;

/** 只为新的直接成员建一层；子摘要原文由持久化 DAG 指向，不重复复制。 */
export function buildContextFold(
  entries: readonly RuntimeMessageEntry[],
  retained: readonly RuntimeMessageEntry[] = [],
): ContextFoldMetadata {
  const retainedIds = new Set(
    retained.flatMap((entry) =>
      entry.kind !== "attachment" && entry.messageId ? [entry.messageId] : [],
    ),
  );
  const members = new Map<string, Exclude<RuntimeMessageEntry, { kind: "attachment" }>>();
  for (const entry of entries) {
    if (
      entry.kind !== "attachment" &&
      entry.messageId &&
      !retainedIds.has(entry.messageId) &&
      !members.has(entry.messageId)
    )
      members.set(entry.messageId, entry);
  }
  const children = new Set<string>();
  let childLevel = 0;
  let originalMessageCount = 0;
  for (const entry of members.values()) {
    const boundary = entry.metadata?.compactBoundary;
    const hierarchy = entry.metadata?.compactHierarchy;
    if (boundary) {
      children.add(boundary.boundaryId);
      childLevel = Math.max(childLevel, hierarchy?.level ?? 1);
      originalMessageCount += hierarchy?.originalMessageCount ?? 1;
    } else {
      originalMessageCount += 1;
    }
  }
  return {
    memberMessageIds: [...members.keys()] as MessageId[],
    childBoundaryIds: [...children],
    level: childLevel + 1,
    originalMessageCount,
  };
}

/** 摘要保留预算随活跃水位变化，避免固定层数迫使稳定摘要频繁重写。 */
export function retainedSummaryBudget(entries: readonly RuntimeMessageEntry[]): number {
  return Math.min(
    MAX_RETAINED_SUMMARY_TOKENS,
    Math.max(
      MIN_RETAINED_SUMMARY_TOKENS,
      Math.floor(estimateRuntimeEntryTokens(entries) * RETAINED_SUMMARY_RATIO),
    ),
  );
}
