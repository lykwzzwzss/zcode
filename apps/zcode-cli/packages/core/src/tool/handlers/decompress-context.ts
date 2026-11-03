import {
  CoreErrorType,
  DECOMPRESS_CONTEXT_TOOL_NAME,
  DecompressContextInputJsonSchema,
  DecompressContextInputSchema,
  DecompressContextOutputJsonSchema,
  DecompressContextOutputSchema,
  createCoreError,
  type DecompressContextOutput,
} from "@zcode/contracts";
import type { ToolEntry, ToolHandler } from "../types.js";
import {
  resolveDecompressPermissionCapability,
  resolveToFilePath,
  writeRestoredTranscript,
} from "../../native-context/decompress-file.js";
import { requireContextArchiveSuccess } from "../../native-context/tool-errors.js";
const MAX_MODEL_BYTES = 120_000;
const TIMEOUT_MS = 30_000;
export const decompressContextHandler: ToolHandler = async (input, context) => {
  const parsed = DecompressContextInputSchema.parse(input);
  // 路径与端口问题在读完整条 transcript 之前就该暴露：无效目标没必要先扫一遍库。
  let toFilePath: string | undefined;
  if (parsed.toFile !== undefined) {
    const target = resolveToFilePath(parsed.toFile, context);
    if (!target.ok)
      throw createCoreError(CoreErrorType.InvalidInput, target.error, {
        context: { toolName: DECOMPRESS_CONTEXT_TOOL_NAME },
        recoverable: true,
      });
    if (!context.fileSystemPort) {
      throw createCoreError(
        CoreErrorType.ConfigurationError,
        "DecompressContext toFile requires a FileSystemPort, but none is configured.",
        { context: { toolName: DECOMPRESS_CONTEXT_TOOL_NAME } },
      );
    }
    toFilePath = target.filePath;
  }

  const archive = context.sessionStore?.contextArchive;
  if (!archive)
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "ContextArchivePort is not configured for DecompressContext",
      { context: { toolName: DECOMPRESS_CONTEXT_TOOL_NAME }, recoverable: false },
    );
  const { toFile: _toFile, ...selection } = parsed;
  // 读取和写入异常保留原始 cause，由 executor 统一发出失败事件与 failure hook。
  const output = requireContextArchiveSuccess(
    await archive.read({
      ...selection,
      sessionId: context.sessionId,
      signal: context.abortSignal,
    }),
    DECOMPRESS_CONTEXT_TOOL_NAME,
  );
  if (!toFilePath || output.status !== "success") return output;
  const written = await writeRestoredTranscript({
    content: output.content,
    context,
    filePath: toFilePath,
    messageCount: output.messageCount,
    truncated: output.truncated,
  });
  return {
    ...output,
    content: written.confirmation,
    filePath: toFilePath,
    bytesWritten: written.bytesWritten,
    segments: undefined,
  };
};

export const decompressContextToolEntry: ToolEntry = {
  capability: "Restore the original messages of a compacted range into the conversation",
  metadata: {
    // 与 SearchContext 同口径：四个工具常驻直连，system prompt 里也写了用法。
    alwaysLoad: true,
    name: DECOMPRESS_CONTEXT_TOOL_NAME,
    description:
      'Restore the original text of a compaction range (or explicit message ids) from the durable transcript, or with tier "summary" the compact summary that covers the range. With toFile, write the same text to a workspace-relative file and return only a short confirmation (path, bytes, message count, truncation) instead of the transcript.',
    modelInstructions: [
      "Default output is at most 10,000 characters. Follow nextCursor for more; set maxChars explicitly only when a larger excerpt is necessary. A toFile export also covers one page, so continue until nextCursor is absent.",
      "Call CompactStatus first when you do not know the boundary id; omit boundaryId to restore the most recent range.",
      'Set tier "summary" to read the summary layer that covers a range first; switch back to the default tier "original" only when you need the exact wording.',
      "Restored text is durable: it becomes part of the conversation, so restore only the range you actually need.",
      "Prefer SearchContext to locate a needle, then DecompressContext for the surrounding range.",
      "Use toFile (workspace-relative, no absolute paths or '..') for a large range you only need on disk; the transcript is then written there and not returned inline.",
      "toFile only applies when messages are actually restored; not_found results are still returned inline.",
    ],
    // 不带 toFile 时本工具仍是纯读；带 toFile 的那一次调用由 resolvePermissionCapability
    // 单独降级为写工作区，静态声明无法按调用切换。
    readOnly: true,
    destructive: false,
    concurrentSafe: true,
    timeoutMs: TIMEOUT_MS,
    maxOutputBytes: MAX_MODEL_BYTES,
    sideEffectScope: "session",
    riskLevel: "low",
    needsApproval: false,
  },
  handler: decompressContextHandler,
  resolvePermissionCapability: resolveDecompressPermissionCapability,
  formatModelContent: (output) =>
    formatDecompressContext(DecompressContextOutputSchema.parse(output)),
  inputSchema: DecompressContextInputJsonSchema,
  outputSchema: DecompressContextOutputJsonSchema,
  runtimeInputSchema: DecompressContextInputSchema,
  runtimeOutputSchema: DecompressContextOutputSchema,
  permission: {
    // 基础声明保持读权限；toFile 调用在 resolvePermissionCapability 里改判为 edit。
    permission: "session.context.read",
    reason: "Restore folded transcript text of the current session",
    riskLevel: "low",
    sideEffectScope: "session",
    needsApproval: false,
    patternSources: ["toolName"],
    alwaysAllowPatternSources: ["toolName"],
    denyPriority: "beforeAsk",
  },
  resultBudget: {
    maxInlineBytes: MAX_MODEL_BYTES,
    maxModelBytes: MAX_MODEL_BYTES,
    strategy: "truncate",
    preview: { maxBytes: MAX_MODEL_BYTES, direction: "head" },
  },
  timeout: { defaultMs: TIMEOUT_MS, maxMs: TIMEOUT_MS, allowCallOverride: false },
  cancellation: {
    supported: true,
    cleanup: "none",
    userVisibleMessage: "DecompressContext was cancelled",
  },
  trace: {
    required: true,
    propagateToAdapters: true,
    recordInput: "summary",
    recordOutput: "summary",
  },
};

function formatDecompressContext(output: DecompressContextOutput): string {
  if (output.status === "failed") {
    return `DecompressContext failed: ${output.error ?? "unknown error"}`;
  }
  if (output.status === "not_found") return output.content;
  // toFile 成功时 content 已经是含路径/字节数/消息数/truncated 的确认句，不再套恢复头。
  const continuation = output.nextCursor
    ? `\n\nContinue with the same selection and cursor=${output.nextCursor}. toFile writes only this page; use a different path for each continuation page.`
    : "";
  const hierarchy = output.ranges
    .filter((range) => range.level !== undefined)
    .map(
      (range) =>
        `\nBoundary ${range.boundaryId}: level=${range.level}, children=${range.childBoundaryIds?.join(",") || "none"}. Use CompactStatus boundaryId to list child pages.`,
    )
    .join("");
  if (output.filePath) return output.content + continuation;
  // 旧落盘结果没有 tier（undefined），走原分支即可保持逐字节不变。
  if (output.tier === "summary") {
    const header = `Restored ${output.messageCount} compact summary message(s)${output.boundaryId ? ` covering ${output.boundaryId}` : ""}${output.truncated ? " (truncated)" : ""}.`;
    return `${header}${hierarchy}\n\n${output.content}${continuation}`;
  }
  const header = `Restored ${output.messageCount} message(s)${output.boundaryId ? ` from ${output.boundaryId}` : ""}${output.truncated ? " (truncated)" : ""}.`;
  return `${header}\n\n${output.content}${continuation}`;
}
