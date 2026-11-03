import { CoreErrorType, createCoreError } from "@zcode/contracts";

/** 端口的显式失败也必须进入 executor 统一失败路径，不能当成普通成功 output。 */
export function requireContextArchiveSuccess<T extends { status: string; error?: string }>(
  output: T,
  toolName: string,
): T {
  if (output.status === "failed") {
    throw createCoreError(
      CoreErrorType.ToolExecutionFailed,
      output.error ?? `${toolName} could not read the context archive`,
      { context: { toolName }, recoverable: true },
    );
  }
  return output;
}
