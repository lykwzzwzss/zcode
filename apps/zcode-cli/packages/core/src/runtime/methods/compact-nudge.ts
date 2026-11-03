import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { getAutoCompactThreshold } from "../../compact/policy.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { estimateRuntimeEntryTokens } from "../helpers/compact-selection.js";
import { shouldUseMidConversationSystem } from "../helpers/runtime-provider-request-messages.js";
import { isDeepSeekFlashModel, suggestCompactRanges } from "../../native-context/contract.js";
import {
  COMPACT_NOW_TOOL_NAME,
  SEARCH_CONTEXT_TOOL_NAME,
  DECOMPRESS_CONTEXT_TOOL_NAME,
} from "@zcode/contracts";

// 增长提醒（nudge）对齐 billion-context 的两层设计：
// - 增长层：至少 50k 一步（大窗口按自动阈值的 10% 放大），
//   gate = 45% 步长，避免刚提过就反复催；
// - 压力层：自动折叠阈值（effective window − reserve − buffer）的 75% 起每轮提醒，
//   95% 起换成紧急措辞（dsh 的 maxContextLimit 75% / emergencyThresholdPercent 95%）。
// 只注入当轮请求（per_current_turn），不落历史——否则一次提示会永久留在上下文里。
const NUDGE_GROWTH_TOKENS = 50_000;
const NUDGE_PRESSURE_RATIO = 0.75;
const NUDGE_EMERGENCY_RATIO = 0.95;
const NUDGE_MIN_RANGE_TOKENS = 4_000;
const NUDGE_MAX_RANGE_SUGGESTIONS = 3;

export function buildCompactNudgeEntry(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  model: Model,
  tools: readonly { name: string }[],
): RuntimeMessageEntry | undefined {
  // 当轮禁用工具时不能催模型调用，更不能用注册表绕过作用域限制。
  if (entries.length === 0 || !tools.some((tool) => tool.name === COMPACT_NOW_TOOL_NAME))
    return undefined;
  const tokens = estimateRuntimeEntryTokens(entries, {
    useMidConversationSystem: shouldUseMidConversationSystem(runtime.config, model),
  });
  // 和自动折叠用同一份阈值：effective window − output reserve − buffer。
  // 用裸 contextWindow 会在宿主下发更小的 compact.contextWindow 时错位。
  const autoCompactAt = getAutoCompactThreshold({
    contextWindow: model.properties.contextWindow,
    ...runtime.config.compact,
    // 优先级与自动折叠一致（宿主 compact.* 不覆盖模型输出上限）：
    // 模型输出上限小于 21k 时两侧必须按同一个 reserve 算阈值。
    maxOutputTokens: model.optionSpecs.maxOutputTokens.max,
  });
  // 窗口小到 threshold 归零时自动折叠会立刻接管，再催只会每轮刷屏。
  if (autoCompactAt <= 0) return undefined;
  // 大窗口模型按阈值比例放大增长步长（1M 窗口约 97k），小窗口保持 dsh 的 50k。
  const growthStep = Math.max(NUDGE_GROWTH_TOKENS, Math.floor(autoCompactAt * 0.1));
  const growthGate = Math.floor(growthStep * 0.45);
  const pressureAt = Math.floor(autoCompactAt * NUDGE_PRESSURE_RATIO);
  const emergencyAt = Math.floor(autoCompactAt * NUDGE_EMERGENCY_RATIO);
  const lastNudged = runtime.lastCompactNudgeTokenCount;

  if (tokens < pressureAt) {
    // 增长层：水位到步长之后，每再涨 45% 步长才提一次。
    if (tokens < growthStep) return undefined;
    if (lastNudged !== undefined && tokens - lastNudged < growthGate) {
      return undefined;
    }
  } else if (lastNudged === tokens) {
    // 压力层每轮都会命中；同一水位不重复注入第二条。
    return undefined;
  }
  runtime.lastCompactNudgeTokenCount = tokens;

  const level = tokens >= emergencyAt ? "emergency" : tokens >= pressureAt ? "pressure" : "growth";
  const flash = isDeepSeekFlashModel(model);
  const suggestions = flash
    ? suggestCompactRanges(entries, {
        minTokens: NUDGE_MIN_RANGE_TOKENS,
        maxRanges: NUDGE_MAX_RANGE_SUGGESTIONS,
      })
    : [];
  return systemReminderAttachmentEntry(
    "compact_nudge",
    [
      `上下文已约 ${Math.round(tokens / 1000)}k tokens（${
        level === "emergency"
          ? "已接近自动折叠阈值"
          : level === "pressure"
            ? "上下文压力偏高"
            : "增长提醒"
      }）。`,
      flash
        ? "已消费且不再需要逐字查看的完整区间，可在一次 CompactNow 中批量提交 ranges[].summary：直接写精简摘要，保留未完成目标、约束、文件、决策和精确字符串，避免额外摘要请求。不要重写仍在使用的最近内容。"
        : level === "emergency"
          ? "立即调用 CompactNow 折叠一次，并在 instructions 里写死必须保留的文件、决策与精确字符串。"
          : "如果后续工作不再依赖早期细节，调用 CompactNow 主动折叠一次，并在 instructions 里写明必须保留的文件、决策与精确字符串。",
      ...suggestions.map(
        (range) =>
          `完整区间建议 ${range.startMessageId}..${range.endMessageId}（约 ${Math.round(range.estimatedTokens / 1000)}k tokens，较近的已完成大块优先；仍需使用则保留）。`,
      ),
      ...(tools.some((tool) => tool.name === SEARCH_CONTEXT_TOOL_NAME)
        ? ["SearchContext 可以检索被折叠的原文。"]
        : []),
      ...(tools.some((tool) => tool.name === DECOMPRESS_CONTEXT_TOOL_NAME)
        ? ["DecompressContext 可以分页取回折叠区间的完整原文。"]
        : []),
      "不调用也不会丢数据，接近阈值时会自动折叠。",
    ].join("\n"),
  );
}
