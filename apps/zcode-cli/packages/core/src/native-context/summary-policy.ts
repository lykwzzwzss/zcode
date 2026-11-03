import { type CompactCacheUsage } from "@zcode/contracts";
import { retainedSummaryBudget } from "./contract.js";
import { CompactTrigger, MAX_OUTPUT_TOKENS_FOR_SUMMARY, isCoreError } from "../runtime/deps.js";
import {
  estimateRuntimeEntryTokens,
  hasEnoughRuntimeEntriesToCompact,
  selectCompactEntries,
  selectCompactEntriesForInitialPromptTooLong,
} from "../runtime/helpers/index.js";
import type {
  Logger,
  Model,
  ModelCatalogPort,
  ModelSelection,
  ModelUsage,
} from "../runtime/deps.js";
import { type RuntimeMessageEntry } from "../agent/message-history.js";
import { resolveNormalRequestMaxOutputTokens } from "../runtime/methods/model-token-limits.js";

export function isAutoCompactRetryableError(error: unknown): boolean {
  return isCoreError(error) ? error.retryable : true;
}

/** 摘要模型不可用时退回默认模型的稳定原因码；只进日志，不进用户文案。 */
export type CompactSummaryModelFallbackReason =
  | "model_not_found"
  | "model_disabled"
  | "reasoning_level_missing"
  | "reasoning_level_not_supported";

export interface CompactSummaryModelResolution {
  model: Model;
  source: "default" | "configured";
  /** 配置了但不可用时，退回默认模型的原因。 */
  fallbackReason?: CompactSummaryModelFallbackReason;
}

/**
 * 解析本次折叠用哪个模型。
 *
 * 未配置 `config.compactSummaryModel` 时直接返回传入的默认模型——与未加该配置字段时
 * 完全一致（调用方传的就是原来的 options.model ?? session 选择）。
 *
 * 配置后先按 ModelCatalogPort 的活视图校验（存在、未禁用、推理档位可用），再交给
 * ModelFactory 创建。目录明确判定的配置不可用才 warn 并退回默认模型；目录实现和
 * 工厂内部异常上抛，不能把真实程序错误伪装成可选增强缺失。摘要请求仍用 no-tools prompt、tool-call 拒绝和
 * MAX_OUTPUT_TOKENS_FOR_SUMMARY 上限，不会因为换模型获得工具能力。
 */
export function resolveCompactSummaryModel(input: {
  configured?: ModelSelection;
  /** 宿主注册表的同步活视图；缺席时只能靠 ModelFactory 的校验兜底。 */
  catalog?: Pick<ModelCatalogPort, "listModels">;
  createModel: (selection: ModelSelection) => Model;
  fallbackModel: Model;
  logger?: Pick<Logger, "info" | "warn">;
  logContext?: Record<string, unknown>;
}): CompactSummaryModelResolution {
  const fallback = (
    reason?: CompactSummaryModelFallbackReason,
    detail?: string,
  ): CompactSummaryModelResolution => {
    const providerId = String(input.fallbackModel.providerId);
    const modelId = String(input.fallbackModel.modelId);
    const context = {
      ...input.logContext,
      event: "compact.summary_model.resolved",
      module: "core.runtime",
      model: `${providerId}/${modelId}`,
      source: "default" as const,
      ...(reason ? { fallbackReason: reason } : {}),
      ...(detail ? { fallbackDetail: detail } : {}),
    };
    if (reason) {
      input.logger?.warn("Compact summary model unavailable; using the default model", context);
    } else {
      input.logger?.info("Compact summary model resolved", context);
    }
    return {
      model: input.fallbackModel,
      source: "default",
      ...(reason ? { fallbackReason: reason } : {}),
    };
  };

  if (!input.configured) return fallback();

  // 配置校验有显式结果；未知异常不能与已知的不可用状态混在同一个回退分支。
  const checked = validateCompactSummaryModelSelection(input.configured, input.catalog);
  if (!checked.ok) return fallback(checked.reason, checked.detail);

  const model = input.createModel(checked.selection);

  const providerId = String(model.providerId);
  const modelId = String(model.modelId);
  input.logger?.info("Compact summary model resolved", {
    ...input.logContext,
    event: "compact.summary_model.resolved",
    module: "core.runtime",
    model: `${providerId}/${modelId}`,
    source: "configured",
  });
  return { model, source: "configured" };
}

/**
 * 用目录活视图校验配置的摘要模型。
 * 没有目录端口时无法在 core 侧判断可用性，保留原 Selection 交给 ModelFactory；
 * 那里的 Selection 校验抛错同样会被 resolveCompactSummaryModel 接住并回退。
 */
function validateCompactSummaryModelSelection(
  configured: ModelSelection,
  catalog: Pick<ModelCatalogPort, "listModels"> | undefined,
):
  | { ok: true; selection: ModelSelection }
  | {
      ok: false;
      reason: CompactSummaryModelFallbackReason;
      detail?: string;
    } {
  if (!catalog) return { ok: true, selection: configured };

  const entry = catalog
    .listModels()
    .find(
      (candidate) =>
        candidate.providerId === configured.providerId && candidate.modelId === configured.modelId,
    );
  if (!entry) return { ok: false, reason: "model_not_found" };
  if (entry.disabledReason) {
    return { ok: false, reason: "model_disabled", detail: entry.disabledReason };
  }
  const reasoningLevel = configured.options?.reasoningLevel ?? entry.defaultReasoningLevel;
  if (reasoningLevel === undefined) return { ok: false, reason: "reasoning_level_missing" };
  if (!entry.reasoningLevels.includes(reasoningLevel)) {
    return { ok: false, reason: "reasoning_level_not_supported", detail: reasoningLevel };
  }
  return {
    ok: true,
    // ModelFactory 要求完整 Selection；配置里通常只写 provider/model，这里补目录默认档位。
    selection: {
      providerId: configured.providerId,
      modelId: configured.modelId,
      options: { reasoningLevel },
    },
  };
}

/**
 * 从 provider 的 ModelUsage 里提取「这次折叠本身」的计量。
 * 字段名与 ModelUsage 一致（inputTokens/cacheReadTokens/cacheWriteTokens/outputTokens）；
 * 未上报的维度保持 undefined——0 是合法计量，不能拿来冒充未知。
 */
export function toCompactCacheUsage(usage: ModelUsage | undefined): CompactCacheUsage | undefined {
  if (!usage) return undefined;
  const cacheUsage: CompactCacheUsage = {};
  if (isTokenCount(usage.inputTokens)) cacheUsage.inputTokens = usage.inputTokens;
  if (isTokenCount(usage.cacheReadTokens)) cacheUsage.cacheReadTokens = usage.cacheReadTokens;
  if (isTokenCount(usage.cacheWriteTokens)) cacheUsage.cacheWriteTokens = usage.cacheWriteTokens;
  if (isTokenCount(usage.outputTokens)) cacheUsage.outputTokens = usage.outputTokens;
  return Object.keys(cacheUsage).length > 0 ? cacheUsage : undefined;
}

function isTokenCount(value: number | undefined): value is number {
  // 与 CompactStatus 输出 schema 的 int().nonnegative() 保持同口径：
  // 非整数说明 provider 数据不可信，按未上报处理，不落一份读侧会被丢掉的计量。
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function canUseCompactSummaryTruncationFallback(trigger: CompactTrigger): boolean {
  return trigger !== CompactTrigger.Auto && trigger !== CompactTrigger.Reactive;
}

export function selectInitialCompactEntriesForActiveConversation(input: {
  activeEntries: readonly RuntimeMessageEntry[];
  initialPromptTooLongCause?: unknown;
  trigger: CompactTrigger;
  useMidConversationSystem?: boolean;
}) {
  const baseSelection = selectCompactEntries({
    entries: input.activeEntries,
    trigger: input.trigger,
  });
  if (input.initialPromptTooLongCause === undefined) {
    return baseSelection;
  }

  return (
    selectCompactEntriesForInitialPromptTooLong({
      entries: input.activeEntries,
      promptTooLongCause: input.initialPromptTooLongCause,
      trigger: input.trigger,
      useMidConversationSystem: input.useMidConversationSystem,
    }) ?? baseSelection
  );
}

/** 摘要请求的输出上限：模型上限与 summary 专用上限取小，切换摘要模型也不会突破它。 */
export function capCompactSummaryMaxOutputTokens(model: Model): number {
  // Compact 是独立执行链，在这里显式选择模型上限与 summary 20K 上限中的较小值。
  return Math.min(
    resolveNormalRequestMaxOutputTokens({
      modelMaxOutputTokens: model.optionSpecs.maxOutputTokens.max,
    }),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  );
}

// —— 增量折叠的辅助判定 ——
// 摘要条目与用户消息同形（role:"user"），唯一可靠的标记是 metadata.compactBoundary；
// 用形态判断而不是内容匹配，避免把用户偶然复述的「Summary:」当成旧摘要。

type CompactSummaryEntryShape = {
  metadata?: {
    compactBoundary?: { boundaryId?: unknown };
    retainedCompactSummary?: boolean;
    /**
     * 这一层摘要当年代理过的更早层 boundaryId（旧→新）。只在 runtime 内存里流转：
     * 落盘时以 compaction part 的 metadata.coversBoundaryIds 为准；这里保留一份是为了
     * 同一进程里的下一次折叠能把闭包继续传下去（冷恢复拿不到，见 collectMerged... 注释）。
     */
    coversBoundaryIds?: readonly string[];
  };
};

function collectPriorCompactSummaries(
  entries: readonly RuntimeMessageEntry[],
): RuntimeMessageEntry[] {
  return entries.filter(isPriorCompactSummaryEntry);
}

/**
 * 把「保留的最近几层摘要」从摘要输入里摘出来，更早的层留在输入里一起重写。
 * 只摘不写会让旧层既不在上下文、也不在新摘要里，形成静默的覆盖缺口。
 *
 * 同时回报这次真正被并进新摘要的旧层 boundaryId（mergedSummaryBoundaryIds）：
 * 读侧要能沿这条父子链把「摘要消息已被裁掉」的旧 boundary 解析到覆盖它的最新摘要。
 */
export function splitRetainedSummaries(
  entries: RuntimeMessageEntry[],
  fallbackWhenInsufficient = true,
): {
  priorSummaryEntries: RuntimeMessageEntry[];
  entriesForSummary: RuntimeMessageEntry[];
  mergedSummaryBoundaryIds: string[];
} {
  const prior = collectPriorCompactSummaries(entries);
  if (prior.length === 0) {
    return { priorSummaryEntries: [], entriesForSummary: entries, mergedSummaryBoundaryIds: [] };
  }
  const retained: RuntimeMessageEntry[] = [];
  let retainedTokens = 0;
  const budget = retainedSummaryBudget(entries);
  for (const entry of [...prior].reverse()) {
    const tokens = estimateRuntimeEntryTokens([entry]);
    if (retainedTokens + tokens > budget) break;
    retained.unshift(entry);
    retainedTokens += tokens;
  }
  const retainedSet = new Set(retained);
  const withoutRetained = entries
    .filter((entry) => !(isPriorCompactSummaryEntry(entry) && retainedSet.has(entry)))
    // 更早的层要进摘要请求，但同样只送正文：续写前言留在输入里会被摘要器抄进新摘要。
    .map((entry) => (isPriorCompactSummaryEntry(entry) ? stripPriorSummaryEntry(entry) : entry));
  // 新增区间太少、只剩旧摘要时不能直接 skipped：退回非增量，把旧摘要一起重写，
  // 否则 prompt-too-long 的恢复路径会把原始超窗错误抛回去。
  if (
    fallbackWhenInsufficient &&
    !hasEnoughRuntimeEntriesToCompact(withoutRetained) &&
    hasEnoughRuntimeEntriesToCompact(entries)
  ) {
    // 这条路径把所有旧摘要都写进新摘要，等于全部被合并；必须一并记为 covers。
    return {
      priorSummaryEntries: [],
      entriesForSummary: entries,
      mergedSummaryBoundaryIds: collectMergedSummaryBoundaryIds(prior, new Set()),
    };
  }
  return {
    priorSummaryEntries: retained,
    entriesForSummary: withoutRetained,
    // 只记录真正进入摘要请求的层；slice 之后仍保留的最近 N 层不算合并。
    mergedSummaryBoundaryIds: collectMergedSummaryBoundaryIds(prior, retainedSet),
  };
}

/**
 * 收集「被本次折叠合并」的旧摘要 boundaryId，旧→新、去重。
 * 冷恢复出来的保留摘要只有 retainedCompactSummary 标记、没有 compactBoundary，
 * 拿不到 boundaryId，只能跳过：宁可少记一条链，也不能写一个错 id 把读侧引到别的层。
 *
 * 传递闭包：被合并的摘要自己也可能代理过更早的层（metadata.coversBoundaryIds）。
 * 只记它自己的 boundaryId 的话，多代折叠后（B 并入 C、C 再并入 D）最早那批 boundary
 * 就再也解析不到 D 的摘要；因此先把旧层的 covers 原样带过来，再追加它自己的 id。
 */
function collectMergedSummaryBoundaryIds(
  priorEntries: readonly RuntimeMessageEntry[],
  retainedEntries: ReadonlySet<RuntimeMessageEntry>,
): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const push = (boundaryId: unknown) => {
    if (typeof boundaryId !== "string" || boundaryId.length === 0) return;
    if (seen.has(boundaryId)) return;
    seen.add(boundaryId);
    ids.push(boundaryId);
  };
  for (const entry of priorEntries) {
    // priorEntries 本身按历史顺序（旧→新），保留层是尾部连续的一段。
    if (retainedEntries.has(entry)) continue;
    const metadata = (entry as CompactSummaryEntryShape).metadata;
    // 先写更早的层，再写这一层自己的 boundary，顺序才是严格旧→新。
    for (const boundaryId of metadata?.coversBoundaryIds ?? []) push(boundaryId);
    push(metadata?.compactBoundary?.boundaryId);
  }
  return ids;
}

function isPriorCompactSummaryEntry(entry: RuntimeMessageEntry): boolean {
  if (entry.kind === "attachment") return false;
  const metadata = (entry as CompactSummaryEntryShape).metadata;
  // 冷恢复出来的保留摘要没有 compactBoundary，只有 hydrated 标记。
  return metadata?.compactBoundary !== undefined || metadata?.retainedCompactSummary === true;
}

// 保留层每折一次多一层；不设上限的话，每次折叠都要把全部历史摘要再落盘一遍，
// 上下文下限也会随折叠次数单调抬高。超过上限的旧层仍可从 SearchContext/DecompressContext 取回。

const COMPACT_SUMMARY_PREAMBLE =
  "This session is being continued from a previous conversation that ran out of context. The summary below covers the earlier portion of the conversation.";

const COMPACT_SUMMARY_FOOTERS = [
  "\nContinue the conversation from where it left off without asking the user any further questions.",
  "\nIf you need specific details from before compaction",
  "\nYour REPL VM state has been cleared as part of this compaction.",
] as const;

/**
 * 保留的是旧摘要的「索引正文」，不是整条续写消息。
 * 原样保留会把每层的「不要向用户提问、直接继续」重复堆进上下文。
 */
function stripCompactSummaryPreamble(text: string): string {
  let body = text.trimStart();
  if (body.startsWith(COMPACT_SUMMARY_PREAMBLE)) {
    body = body.slice(COMPACT_SUMMARY_PREAMBLE.length).trimStart();
  }
  for (const marker of COMPACT_SUMMARY_FOOTERS) {
    const index = body.indexOf(marker);
    if (index >= 0) body = body.slice(0, index).trimEnd();
  }
  return body;
}

function stripPriorSummaryEntry(entry: RuntimeMessageEntry): RuntimeMessageEntry {
  if (entry.kind === "attachment") return entry;
  const content = entry.message.content;
  if (typeof content !== "string") return entry;
  const stripped = stripCompactSummaryPreamble(content);
  return stripped === content
    ? entry
    : { ...entry, message: { ...entry.message, content: stripped } };
}
