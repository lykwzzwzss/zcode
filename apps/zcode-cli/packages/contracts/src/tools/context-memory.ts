import { z } from "zod";
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
  })
  .strict();

export type SearchContextInput = z.infer<typeof SearchContextInputSchema>;
export const SearchContextInputJsonSchema = toToolJsonSchema(SearchContextInputSchema);

export const ContextMemoryMatchSchema = z
  .object({
    messageId: z.string(),
    role: z.enum(["user", "assistant"]),
    createdAt: z.number().int().nonnegative(),
    folded: z.boolean(),
    score: z.number(),
    snippet: z.string(),
  })
  .strict();

export const SearchContextOutputSchema = z
  .object({
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

export const DecompressContextOutputSchema = z
  .object({
    status: z.enum(["success", "not_found", "failed"]),
    sessionId: z.string(),
    boundaryId: z.string().optional(),
    messageCount: z.number().int().nonnegative(),
    content: z.string(),
    truncated: z.boolean(),
    ranges: z.array(CompactedRangeOutputSchema),
    error: z.string().optional(),
  })
  .strict();

export type DecompressContextOutput = z.infer<typeof DecompressContextOutputSchema>;
export const DecompressContextOutputJsonSchema = toToolJsonSchema(DecompressContextOutputSchema);

export const CompactStatusInputSchema = z.object({}).strict();

export type CompactStatusInput = z.infer<typeof CompactStatusInputSchema>;
export const CompactStatusInputJsonSchema = toToolJsonSchema(CompactStatusInputSchema);

export const CompactStatusOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    sessionId: z.string(),
    messageCount: z.number().int().nonnegative(),
    activeMessageCount: z.number().int().nonnegative(),
    foldedMessageCount: z.number().int().nonnegative(),
    lastCompactAt: z.number().int().nonnegative().optional(),
    ranges: z.array(CompactedRangeOutputSchema),
    error: z.string().optional(),
  })
  .strict();

export type CompactStatusOutput = z.infer<typeof CompactStatusOutputSchema>;
export const CompactStatusOutputJsonSchema = toToolJsonSchema(CompactStatusOutputSchema);

export const CompactNowInputSchema = z
  .object({
    instructions: z
      .string()
      .max(4000)
      .optional()
      .describe("What the next summary must preserve or emphasize."),
    reason: z
      .enum(["context_pressure", "task_shift", "user_request"])
      .optional()
      .default("context_pressure"),
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
