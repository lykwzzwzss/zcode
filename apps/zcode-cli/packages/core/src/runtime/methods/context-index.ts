import {
  isRuntimeAttachmentEntry,
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
  type RuntimeMessageMessageEntry,
} from "../../agent/message-history.js";
import { modelMessageContentToText, type Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { estimateRuntimeEntryTokens } from "../helpers/compact-selection.js";
import { shouldUseMidConversationSystem } from "../helpers/runtime-provider-request-messages.js";
import {
  COMPACT_NOW_TOOL_NAME,
  SEARCH_CONTEXT_TOOL_NAME,
  DECOMPRESS_CONTEXT_TOOL_NAME,
} from "@zcode/contracts";

// 消息索引解决的是「模型看不见上下文里有哪些消息」：折叠之后模型只知道摘要，
// 想点名取回某条原文却没有 id。索引把当前上下文里的对话消息按时间正序列出来，
// 每行给 id、估算 token 与类型，模型就能直接用 SearchContext / DecompressContext 点名。
// 设计取舍：
// - 40k 以下不注入：小上下文里模型本来就能看到全部消息，索引是纯开销；
// - 只列对话条目：attachment（system reminder）不是可检索的对话原文，点名它们没有意义；
// - 只保留最新一段：越早的消息越可能已经折叠，索引本身也不能无限膨胀；
// - per_current_turn：每轮重新生成、不落历史，否则旧索引会永久占住上下文。
const CONTEXT_INDEX_MIN_TOKENS = 40_000;
const CONTEXT_INDEX_MAX_ENTRIES = 60;
const CONTEXT_INDEX_MAX_CHARS = 3_000;

type ContextIndexKind = "user" | "assistant" | "tool" | `summary:L${number}`;

export function buildContextIndexEntry(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  model: Model,
  tools: readonly { name: string }[],
): RuntimeMessageEntry | undefined {
  // 子代理运行时没有折叠与取回的场景（由父代理负责），注入索引只会白占 token。
  if (runtime.config.taskType === "subagent_child") return undefined;
  if (entries.length === 0) return undefined;
  // 索引与 nudge 使用同一当轮作用域；全禁用时不花 token 提示不可调用的工具。
  const toolNames = new Set(tools.map((tool) => tool.name));
  const uses = [
    ...(toolNames.has(COMPACT_NOW_TOOL_NAME) ? ["持久化 id 可用于 CompactNow ranges。"] : []),
    ...(toolNames.has(DECOMPRESS_CONTEXT_TOOL_NAME)
      ? ["持久化 id 可用于 DecompressContext messageIds。"]
      : []),
    ...(toolNames.has(SEARCH_CONTEXT_TOOL_NAME) ? ["SearchContext 按关键词搜索。"] : []),
  ];
  if (uses.length === 0) return undefined;

  // 与请求估算 / 折叠判定同一口径：MCS 下 attachment 会并进 system，token 数会不同。
  const useMidConversationSystem = shouldUseMidConversationSystem(runtime.config, model);
  const totalTokens = estimateRuntimeEntryTokens(entries, { useMidConversationSystem });
  // 水位以下不生成：索引是给「上下文已经很大、模型记不住细节」的场景用的。
  if (totalTokens < CONTEXT_INDEX_MIN_TOKENS) return undefined;

  // 只列有持久化 id 的对话条目：SearchContext / DecompressContext 只按
  // message.info.id 查找，位置编号无法被解析。没有稳定 id 的条目直接不列，宁缺勿错。
  const indexable = entries.filter(isContextIndexEntry);
  if (indexable.length === 0) return undefined;

  // 一条持久化消息可能拆成多个运行时条目（assistant 文本与它的 tool 结果共用 message.info.id）：
  // 按 id 合并成一行，否则同一 id 会重复出现，模型也无法判断该点名哪一行。
  const groups = groupContextIndexEntries(indexable, useMidConversationSystem);

  const header =
    `上下文索引：当前上下文约 ${formatTokenCount(totalTokens)} tokens，` +
    "以下是按时间正序排列的对话消息（每行：id · 估算 tokens · 类型；system reminder 附件不列出）。";
  const footer = uses.join("") + "每行 token 数是本地估算值，不是 provider 的精确计数。";

  // 从最新一条往前装：超预算时先丢最早的消息，索引永远优先覆盖尾部（模型最常回看的部分）。
  const lines: string[] = [];
  let usedChars = 0;
  for (
    let cursor = groups.length - 1;
    cursor >= 0 && lines.length < CONTEXT_INDEX_MAX_ENTRIES;
    cursor -= 1
  ) {
    const group = groups[cursor]!;
    const line = formatContextIndexLine(group);
    if (usedChars + line.length + 1 > CONTEXT_INDEX_MAX_CHARS) break;
    lines.push(line);
    usedChars += line.length + 1;
  }
  // 上面的循环倒序取，展示时翻回时间正序。
  lines.reverse();

  // 省略说明本身也占字符：整体仍超预算时继续丢最旧的一条，直到装得下。
  let body = "";
  for (;;) {
    const omitted = groups.length - lines.length;
    body = [
      header,
      ...(omitted > 0 ? [`… 更早的 ${omitted} 条消息已省略`] : []),
      ...lines,
      footer,
    ].join("\n");
    if (body.length <= CONTEXT_INDEX_MAX_CHARS || lines.length === 0) break;
    lines.shift();
  }
  return systemReminderAttachmentEntry("context_index", body);
}

function isContextIndexEntry(
  entry: RuntimeMessageEntry,
): entry is RuntimeMessageMessageEntry & { messageId: string } {
  // attachment 是 system reminder / 公告，不是可点名的对话原文。
  if (isRuntimeAttachmentEntry(entry)) return false;
  // 没有持久化 id 的条目索引不了：不能用位置编号顶替，否则工具解析不到这条消息。
  if (!entry.messageId) return false;
  // 输出续写提示只属于单次请求，不在持久化对话里，点名它没有意义。
  if (entry.queryScope === "output_token_continuation") return false;
  switch (entry.message.role) {
    case "user":
    case "tool":
      return true;
    case "assistant":
      // 只认可见文本与工具调用：纯 reasoning 条目在上下文里几乎不可回看，列出来只会干扰模型。
      return (
        (entry.message.toolCalls?.length ?? 0) > 0 ||
        modelMessageContentToText(entry.message.content).trim().length > 0
      );
    default:
      // system：会话前缀 / 上下文指令，不是对话消息。
      return false;
  }
}

function formatContextIndexLine(group: ContextIndexGroup): string {
  const kinds = group.kinds.join("+");
  return `${group.messageId} · ${formatTokenCount(group.tokens)} · ${kinds}`;
}

type ContextIndexGroup = {
  messageId: string;
  tokens: number;
  kinds: ContextIndexKind[];
};

// 同一 messageId 的条目在时间上相邻（assistant 文本与紧随其后的 tool 结果），
// 因此按相邻去重即可，不需要全局 map：顺序必须原样保留给展示与截断。
function groupContextIndexEntries(
  indexable: readonly (RuntimeMessageMessageEntry & { messageId: string })[],
  useMidConversationSystem: boolean,
): ContextIndexGroup[] {
  const groups: ContextIndexGroup[] = [];
  for (const entry of indexable) {
    // 与总水位用同一个估算器：同一份 token 口径下，各行之和才对得上头部的水位数字。
    const tokens = estimateRuntimeEntryTokens([entry], { useMidConversationSystem });
    const kind = contextIndexKind(entry);
    const last = groups.at(-1);
    if (last?.messageId === entry.messageId) {
      last.tokens += tokens;
      if (!last.kinds.includes(kind)) last.kinds.push(kind);
      continue;
    }
    groups.push({ messageId: entry.messageId, tokens, kinds: [kind] });
  }
  return groups;
}

function contextIndexKind(entry: RuntimeMessageMessageEntry): ContextIndexKind {
  if (entry.metadata?.compactBoundary)
    return `summary:L${entry.metadata.compactHierarchy?.level ?? 1}`;
  switch (entry.message.role) {
    case "assistant":
      return "assistant";
    case "tool":
      return "tool";
    default:
      return "user";
  }
}

function formatTokenCount(tokens: number): string {
  if (tokens < 1_000) return `${tokens}`;
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(1)}K`;
  return `${(tokens / 1_000_000).toFixed(1)}M`;
}
