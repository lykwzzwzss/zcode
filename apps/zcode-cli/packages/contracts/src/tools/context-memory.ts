import { z } from "zod";
import type { CompactCacheUsage } from "../interfaces/session-store.port.js";
import { toToolJsonSchema } from "./json-schema.js";

// 会话记忆四件套：模型自己检索被折叠掉的历史、把某个折叠区间解压回上下文、
// 查看折叠状态、以及在它认为该折的时候主动折一次。
// 与 ReadSessionContext 的分工：那个走 activeSessionMessages（折叠后视角），
// 这一组直接读持久化 transcript（SQLite 里从未删除的原文）。

export const SEARCH_CONTEXT_TOOL_NAME = "SearchContext";
export const DECOMPRESS_CONTEXT_TOOL_NAME = "DecompressContext";
export const COMPACT_STATUS_TOOL_NAME = "CompactStatus";
export const COMPACT_NOW_TOOL_NAME = "CompactNow";

export const CONTEXT_MEMORY_DEFAULT_MAX_CHARS = 20_000;
export const CONTEXT_MEMORY_MAX_CHARS = 80_000;
export const CONTEXT_MEMORY_DEFAULT_MAX_RESULTS = 8;
export const CONTEXT_MEMORY_MAX_RESULTS = 40;

export const SearchContextInputSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe("Continue a pinned search page using the previous nextCursor."),
    query: z
      .string()
      .min(1)
      .max(4000)
      .describe("Keywords or a short phrase to find. Matching is case-insensitive substring."),
    maxResults: z
      .number()
      .int()
      .positive()
      .max(CONTEXT_MEMORY_MAX_RESULTS)
      .optional()
      .default(CONTEXT_MEMORY_DEFAULT_MAX_RESULTS)
      .describe("Maximum number of matching messages to return."),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(CONTEXT_MEMORY_MAX_CHARS)
      .optional()
      .describe("Approximate maximum characters to return in total."),
    role: z
      .enum(["any", "user", "assistant"])
      .optional()
      .default("any")
      .describe("Only search messages produced by this role."),
    includeFolded: z
      .boolean()
      .optional()
      .default(true)
      .describe(
        "Include messages that were folded away by earlier compactions. Defaults to true — this is the main reason to use the tool.",
      ),
    // 折叠摘要本身也算一种可检索历史：模型常常只记得「总结里提过这件事」，
    // 先定位到那一层摘要、再按 boundaryId 解压原文，比直接猜关键词扫全量正文便宜得多。
    // 默认 all 是为了让旧调用方不用改参数也能搜到摘要；要严格复现旧行为就显式传 messages。
    scope: z
      .enum(["messages", "summaries", "all"])
      .optional()
      .default("all")
      .describe(
        'What to search: "messages" for raw transcript only, "summaries" for compaction summaries only, "all" (default) for both. Summary matches carry a boundaryId you can hand to DecompressContext.',
      ),
  })
  .strict();

export type SearchContextInput = z.infer<typeof SearchContextInputSchema>;
export const SearchContextInputJsonSchema = toToolJsonSchema(SearchContextInputSchema);

export const ContextMemoryMatchSchema = z
  .object({
    // 命中身份：原始消息还是折叠摘要。默认 message 让「只含旧字段」的存量结果仍能通过解析，
    // 新结果一律显式写；scope=messages 时全部是 message，输出与旧版逐字节相同。
    kind: z.enum(["message", "summary"]).optional().default("message"),
    messageId: z.string(),
    // 摘要命中时显式给出摘要消息自身的持久化 id（与 messageId 相同）。
    // 单独保留字段是为了让读侧不必反推「这条 id 是摘要还是普通消息」。
    summaryMessageId: z.string().optional(),
    // 摘要命中能定位到某次折叠时给出；可直接作为 DecompressContext 的 boundaryId。
    boundaryId: z.string().optional(),
    // 摘要已不在当前上下文、且库里找不到它自己的 boundary（被保留层上限裁掉的旧层）时为 true。
    retained: z.boolean().optional(),
    role: z.enum(["user", "assistant"]),
    createdAt: z.number().int().nonnegative(),
    folded: z.boolean(),
    score: z.number(),
    snippet: z.string(),
  })
  .strict();

export const SearchContextOutputSchema = z
  .object({
    nextCursor: z.string().optional(),
    status: z.enum(["success", "not_found", "failed"]),
    query: z.string(),
    sessionId: z.string(),
    matches: z.array(ContextMemoryMatchSchema),
    searchedMessageCount: z.number().int().nonnegative(),
    foldedMessageCount: z.number().int().nonnegative(),
    truncated: z.boolean(),
    error: z.string().optional(),
  })
  .strict();

export type SearchContextOutput = z.infer<typeof SearchContextOutputSchema>;
export const SearchContextOutputJsonSchema = toToolJsonSchema(SearchContextOutputSchema);

export const DecompressContextInputSchema = z
  .object({
    cursor: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        "Continue the previous nextCursor with the same selection to recover the remaining original text without gaps or duplicates.",
      ),
    // 逐级解压的档位：original 是存量语义（取回被折叠的原文），summary 是「先只取回
    // 覆盖该区间的那一层摘要」。默认 original 保证旧调用方行为完全不变。
    tier: z
      .enum(["original", "summary"])
      .optional()
      .default("original")
      .describe(
        'What to restore. "original" (default) returns the folded transcript text; "summary" returns the compact summary that covers the range instead of the raw messages.',
      ),
    boundaryId: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe("Compaction boundary to restore. Omit to restore the most recent one."),
    messageIds: z
      .array(z.string().min(1).max(128))
      .max(200)
      .optional()
      .describe("Explicit persisted message ids to restore instead of a whole boundary."),
    toFile: z
      .string()
      .min(1)
      .max(4096)
      .optional()
      .describe(
        "Workspace-relative file path. When set, the restored transcript is written to this file and the tool result carries only a short confirmation (path, byte count, message count, truncation) instead of the transcript text.",
      ),
    maxChars: z
      .number()
      .int()
      .positive()
      .max(CONTEXT_MEMORY_MAX_CHARS)
      .optional()
      .describe("Approximate maximum characters to return."),
  })
  .strict();

export type DecompressContextInput = z.infer<typeof DecompressContextInputSchema>;
export const DecompressContextInputJsonSchema = toToolJsonSchema(DecompressContextInputSchema);

export const CompactedRangeOutputSchema = z
  .object({
    level: z.number().int().positive().optional(),
    childBoundaryIds: z.array(z.string()).optional(),
    childBoundaryCount: z.number().int().nonnegative().optional(),
    originalMessageCount: z.number().int().nonnegative().optional(),
    memberMessageCount: z.number().int().nonnegative().optional(),
    boundaryId: z.string(),
    messageId: z.string(),
    summaryMessageId: z.string().optional(),
    lastSummarizedMessageId: z.string().optional(),
    summarizedMessageCount: z.number().int().nonnegative(),
    preCompactTokenCount: z.number().optional(),
    postCompactTokenCount: z.number().optional(),
    trigger: z.string().optional(),
    phase: z.string().optional(),
    createdAt: z.number().int().nonnegative(),
  })
  .strict();

// 折叠开销是 CompactStatus 的观测字段；单独建模而不是挂到通用 range 上，
// 避免 DecompressContext 的 ranges 结构跟着变（它不消费这份数据）。
const CompactCacheUsageSchema: z.ZodType<CompactCacheUsage> = z
  .object({
    inputTokens: z.number().int().nonnegative().optional(),
    cacheReadTokens: z.number().int().nonnegative().optional(),
    cacheWriteTokens: z.number().int().nonnegative().optional(),
    outputTokens: z.number().int().nonnegative().optional(),
  })
  .strict();

export const CompactStatusRangeOutputSchema = CompactedRangeOutputSchema.extend({
  /** 该次折叠摘要请求的 provider usage；旧 boundary 或 provider 未上报时缺省。 */
  cacheUsage: CompactCacheUsageSchema.optional(),
});

export const DecompressContextOutputSchema = z
  .object({
    segments: z
      .array(
        z
          .object({
            messageId: z.string(),
            partId: z.string(),
            sourceOffset: z.number().int().nonnegative(),
            start: z.number().int().nonnegative(),
            length: z.number().int().nonnegative(),
          })
          .strict(),
      )
      .optional(),
    nextCursor: z.string().optional(),
    status: z.enum(["success", "not_found", "failed"]),
    sessionId: z.string(),
    // 回显这次实际用的档位。可选是为了让旧版本落盘的工具结果（没有该字段）仍能解析。
    tier: z.enum(["original", "summary"]).optional(),
    boundaryId: z.string().optional(),
    // tier="summary" 时给出真正取回的那条摘要消息 id（可能是覆盖旧 boundary 的更新摘要）。
    summaryMessageId: z.string().optional(),
    messageCount: z.number().int().nonnegative(),
    content: z.string(),
    truncated: z.boolean(),
    filePath: z.string().optional(),
    bytesWritten: z.number().int().nonnegative().optional(),
    ranges: z.array(CompactedRangeOutputSchema),
    error: z.string().optional(),
  })
  .strict();

export type DecompressContextOutput = z.infer<typeof DecompressContextOutputSchema>;
export const DecompressContextOutputJsonSchema = toToolJsonSchema(DecompressContextOutputSchema);

export const CompactStatusInputSchema = z
  .object({
    boundaryId: z.string().min(1).max(128).optional(),
    cursor: z.string().min(1).max(4096).optional(),
    maxRanges: z.number().int().positive().max(200).optional(),
  })
  .strict();

export type CompactStatusInput = z.infer<typeof CompactStatusInputSchema>;
export const CompactStatusInputJsonSchema = toToolJsonSchema(CompactStatusInputSchema);

export const CompactStatusOutputSchema = z
  .object({
    nextCursor: z.string().optional(),
    status: z.enum(["success", "failed"]),
    sessionId: z.string(),
    messageCount: z.number().int().nonnegative(),
    activeMessageCount: z.number().int().nonnegative(),
    foldedMessageCount: z.number().int().nonnegative(),
    lastCompactAt: z.number().int().nonnegative().optional(),
    ranges: z.array(CompactStatusRangeOutputSchema),
    error: z.string().optional(),
  })
  .strict();

export type CompactStatusOutput = z.infer<typeof CompactStatusOutputSchema>;
export const CompactStatusOutputJsonSchema = toToolJsonSchema(CompactStatusOutputSchema);

/**
 * 选择性区间压缩的一段：两端都是持久化会话消息 id（message.info.id）。
 * 执行期会先把端点向外扩到 assistant 开头/结尾的整个 round，所以这里只要求
 * 指向真实存在的消息；顺序、重叠、活跃分支等校验在真正执行折叠前统一做。
 */
export const COMPACT_MODEL_MAX_RANGES = 16;
export const COMPACT_MODEL_MAX_TOTAL_SUMMARY_CHARS = 48_000;
export const COMPACT_MODEL_MAX_RANGE_SUMMARY_CHARS = 24_000;
export const CompactRangeSchema = z
  .object({
    startMessageId: z
      .string()
      .min(1)
      .max(128)
      .describe("Persisted id of the first message in the range to fold."),
    endMessageId: z
      .string()
      .min(1)
      .max(128)
      .describe("Persisted id of the last message in the range to fold."),
    summary: z
      .string()
      .trim()
      .min(1)
      .max(COMPACT_MODEL_MAX_RANGE_SUMMARY_CHARS)
      .optional()
      .describe(
        "Optional caller-supplied summary for this range. Model CompactNow requires one per range; internal runtime-generated compaction may omit it.",
      ),
  })
  .strict();

export type CompactRangeInput = z.infer<typeof CompactRangeSchema>;

export const COMPACT_MODEL_REQUIRED_GUIDANCE =
  'CompactNow requires ranges with an exact startMessageId, endMessageId and nonempty summary for each range. Use persisted IDs from the context index, and retry in this turn: {"ranges":[{"startMessageId":"<first persisted ID>","endMessageId":"<last persisted ID>","summary":"<self-contained summary>"}]}. Do not use instructions instead of summaries.';
export const COMPACT_MODEL_SUMMARY_GUIDANCE =
  "Write only facts needed to continue, not analysis; preserve unfinished work as unfinished. Size each summary to its range without filling the limit. Preserve objectives, constraints, decisions, paths and exact errors; all summaries total at most 48,000 characters.";
export const CompactModelRangeSchema = CompactRangeSchema.extend({
  summary: z
    .string()
    .trim()
    .min(1)
    .max(COMPACT_MODEL_MAX_RANGE_SUMMARY_CHARS)
    .describe(
      `Your self-contained summary for this exact complete-round range. ${COMPACT_MODEL_SUMMARY_GUIDANCE}`,
    ),
});

export const CompactNowInputSchema = z
  .object({
    instructions: z
      .string()
      .max(4000)
      .optional()
      .describe("Optional supplementary context; it cannot replace the summaries you write."),
    preparationToken: z
      .string()
      .min(1)
      .max(128)
      .optional()
      .describe(
        "One-use token returned after PreCompact provides additional requirements; resubmit the same ranges with newly written summaries following those requirements.",
      ),
    reason: z
      .enum(["context_pressure", "task_shift", "user_request"])
      .optional()
      .default("context_pressure"),
    // 选择性区间压缩：显式给出要折的若干段，段与段之间的消息原样保留。
    // 执行侧已接通（P2）：每段独立摘要、原位替换；端点必须是持久化消息 id。
    ranges: z
      .array(CompactModelRangeSchema)
      .min(1)
      .max(COMPACT_MODEL_MAX_RANGES)
      .describe(
        "Required complete-round ranges with one self-contained summary per range. Use persisted message ids, including older summary ids for recursive folding; unselected messages remain active. No separate summary model call is made.",
      ),
  })
  .strict();

export type CompactNowInput = z.infer<typeof CompactNowInputSchema>;
export const CompactNowInputJsonSchema = toToolJsonSchema(CompactNowInputSchema);

export const CompactNowOutputSchema = z
  .object({
    status: z.enum(["accepted", "rejected", "failed"]),
    message: z.string(),
    reason: z.string().optional(),
  })
  .strict();

export type CompactNowOutput = z.infer<typeof CompactNowOutputSchema>;
export const CompactNowOutputJsonSchema = toToolJsonSchema(CompactNowOutputSchema);
