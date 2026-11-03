import { isAbsolute, relative, resolve, sep } from "node:path";
import { CoreErrorType, createCoreError } from "@zcode/contracts";
import type { ToolExecutionContext, ToolRuntimePermissionCapability } from "../tool/types.js";
import { resolveWorkspacePath } from "../tool/path-policy.js";
export function resolveDecompressPermissionCapability(
  input: unknown,
): ToolRuntimePermissionCapability | undefined {
  if (!isRecord(input) || typeof input.toFile !== "string") return undefined;
  return {
    readOnly: false,
    sideEffectScope: "workspace",
    riskLevel: "medium",
    needsApproval: true,
    permission: {
      permission: "edit",
      reason: "DecompressContext writes the restored transcript to a workspace file",
      riskLevel: "medium",
      sideEffectScope: "workspace",
      needsApproval: true,
      // 输入里的落点字段叫 toFile，不叫 path；用 "path" 取不到值会退化成空 pattern。
      // 这里按工具名授权，路径安全由 resolveToFilePath 负责。
      patternSources: ["toolName"],
      alwaysAllowPatternSources: ["toolName"],
      denyPriority: "beforeAsk",
    },
  };
}

/**
 * 把模型给的 toFile 收敛到工作区内的相对路径。
 * 比 path-policy 当前的宽口径更严：这个落点由模型自选、内容是一整段会话原文，
 * 只允许工作区内的相对路径，绝对路径与 `..` 一律拒绝，解析后再做一次边界校验。
 */
export function resolveToFilePath(
  inputPath: string,
  context: ToolExecutionContext,
): { ok: true; filePath: string } | { ok: false; error: string } {
  if (inputPath.length === 0) {
    return { ok: false, error: "toFile must not be empty." };
  }
  // Windows 的 `C:foo` 不是绝对路径（盘符相对），isAbsolute 放得过去，单独拦下。
  if (isAbsolute(inputPath) || /^[a-zA-Z]:/.test(inputPath)) {
    return {
      ok: false,
      error: `toFile must be a workspace-relative path; "${inputPath}" is absolute.`,
    };
  }
  if (inputPath.split(/[\\/]+/).includes("..")) {
    return {
      ok: false,
      error: `toFile must not contain ".." path segments: "${inputPath}".`,
    };
  }

  const filePath = resolveWorkspacePath({
    inputPath,
    operation: "write",
    workingDirectory: context.workingDirectory,
    workspaceRoot: context.workspaceRoot,
  });
  const workspaceRoot = resolve(context.workspaceRoot);
  const relativePath = relative(workspaceRoot, filePath);
  // relative 在跨盘符时返回绝对路径；`..` 前缀与等于根目录都说明落点不在工作区内。
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    return {
      ok: false,
      error: `toFile must resolve to a file inside the workspace (${workspaceRoot}); "${inputPath}" resolves outside it.`,
    };
  }
  return { ok: true, filePath };
}

export async function writeRestoredTranscript(input: {
  content: string;
  context: ToolExecutionContext;
  filePath: string;
  messageCount: number;
  truncated: boolean;
}): Promise<{ bytesWritten: number; confirmation: string }> {
  const fileSystemPort = input.context.fileSystemPort;
  if (!fileSystemPort) {
    throw createCoreError(
      CoreErrorType.ConfigurationError,
      "FileSystemPort is not configured for DecompressContext toFile",
    );
  }
  // 用 TextEncoder 独立计数：不同 FileSystemPort 的 bytesWritten 可能包含换行转换，
  // 而模型需要知道的是这份逻辑文本本身的 UTF-8 字节数。
  const bytesWritten = new TextEncoder().encode(input.content).length;
  // 导出失败不能返回普通 output：保留原始 IO/取消异常，交给 executor 记录失败。
  // atomic 避免留下半截文件，导出快照不做 Write 的 read-before-write/revision 校验。
  await fileSystemPort.writeTextFile(
    {
      path: input.filePath,
      content: input.content,
      createParents: true,
      atomic: true,
      trace: input.context.traceContext,
    },
    { signal: input.context.abortSignal },
  );
  return {
    bytesWritten,
    confirmation: `Wrote ${bytesWritten} bytes from ${input.messageCount} message(s) to ${input.filePath} (truncated: ${input.truncated}).`,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
