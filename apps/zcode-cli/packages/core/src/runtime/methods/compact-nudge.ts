import {
  systemReminderAttachmentEntry,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import { DEFAULT_COMPACT_CONTEXT_WINDOW } from "../../compact/policy.js";
import type { Model } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { estimateRuntimeEntryTokens } from "../helpers/compact-selection.js";
import { shouldUseMidConversationSystem } from "../helpers/runtime-provider-request-messages.js";

// 增长提醒（nudge）对齐 billion-context 的两层设计：
// - 增长层：绝对 50k 一步、与窗口大小无关（dsh 的 nudgeGrowthTokens），
//   gate = max(20k, 0.45 × step) ≈ 22.5k，避免刚提过就反复催；
// - 压力层：窗口 75% 起每轮提醒，95% 起换成紧急措辞
//   （dsh 的 maxContextLimit 75% / emergencyThresholdPercent 95%）。
// 只注入当轮请求（per_current_turn），不落历史——否则一次提示会永久留在上下文里。
const NUDGE_GROWTH_TOKENS = 50_000;
const NUDGE_GROWTH_GATE_TOKENS = 22_500;
const NUDGE_PRESSURE_RATIO = 0.75;
const NUDGE_EMERGENCY_RATIO = 0.95;

export function buildCompactNudgeEntry(
  runtime: AgentRuntimeInternal,
  entries: readonly RuntimeMessageEntry[],
  model?: Model,
): RuntimeMessageEntry | undefined {
  if (entries.length === 0) return undefined;
  const tokens = estimateRuntimeEntryTokens(entries, {
    useMidConversationSystem: model
      ? shouldUseMidConversationSystem(runtime.config, model)
      : true,
  });
  const contextWindow = model?.properties?.contextWindow ?? DEFAULT_COMPACT_CONTEXT_WINDOW;
  const pressureAt = Math.floor(contextWindow * NUDGE_PRESSURE_RATIO);
  const emergencyAt = Math.floor(contextWindow * NUDGE_EMERGENCY_RATIO);
  const lastNudged = runtime.lastCompactNudgeTokenCount;

  if (tokens < pressureAt) {
    // 增长层：水位到 50k 之后，每再涨 22.5k 才提一次。
    if (tokens < NUDGE_GROWTH_TOKENS) return undefined;
    if (lastNudged !== undefined && tokens - lastNudged < NUDGE_GROWTH_GATE_TOKENS) {
      return undefined;
    }
  } else if (lastNudged === tokens) {
    // 压力层每轮都会命中；同一水位不重复注入第二条。
    return undefined;
  }
  runtime.lastCompactNudgeTokenCount = tokens;

  const level = tokens >= emergencyAt ? "emergency" : tokens >= pressureAt ? "pressure" : "growth";
  return systemReminderAttachmentEntry(
    "compact_nudge",
    [
      `上下文已约 ${Math.round(tokens / 1000)}k tokens（${
        level === "emergency" ? "已超过窗口 95%" : level === "pressure" ? "已超过窗口 75%" : "增长提醒"
      }）。`,
      level === "emergency"
        ? "立即调用 CompactNow 折叠一次，并在 instructions 里写死必须保留的文件、决策与精确字符串；被折叠的内容可用 SearchContext / DecompressContext 取回。"
        : "如果后续工作不再依赖早期细节，调用 CompactNow 主动折叠一次，并在 instructions 里写明必须保留的文件、决策与精确字符串。",
      "被折叠的内容没有消失：SearchContext 可以检索原文，DecompressContext 可以把某个折叠区间解压回上下文。",
      "不调用也不会丢数据，接近阈值时会自动折叠。",
    ].join("\n"),
  );
}
