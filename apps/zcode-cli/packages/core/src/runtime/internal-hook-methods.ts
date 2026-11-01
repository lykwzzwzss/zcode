import type { HookRunResult, Model, TraceContext, TurnState } from "./deps.js";
import type { HookEventName } from "@zcode/contracts";
import type { RuntimeMessageEntry } from "../agent/message-history.js";

// 从 internal-methods.ts 拆出，避免该文件越过
// 400 行边界（runtime-module-boundary 测试），hooks 一组方法自成一段，单独成文件。
export interface AgentRuntimeHookMethods {
  runSessionStartHooks(
    source: "startup" | "resume" | "clear" | "compact",
    traceContext: TraceContext,
    signal?: AbortSignal,
    model?: Pick<Model, "providerId" | "modelId">,
  ): Promise<HookRunResult>;
  runUserPromptSubmitHooks(
    prompt: string,
    attachments: TurnState["attachments"] | undefined,
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  runStopHooks(
    response: string,
    toolCallCount: number,
    traceContext: TraceContext,
    signal?: AbortSignal,
    stopHookActive?: boolean,
  ): Promise<HookRunResult>;
  /** compact 前置钩子：可观察折叠范围，也可直接提供折叠摘要（宿主发起压缩）。 */
  runPreCompactHooks(
    input: {
      entriesToSummarize: number;
      /** 待折叠条目的 JSONL 正文，写进钩子的 transcript_path。 */
      entriesTranscript?: string;
      historyTokens: number;
      reason: string;
      summarizeTokens: number;
      trigger: string;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  /** compact 后置钩子：只观察折叠结果。 */
  runPostCompactHooks(
    input: {
      keptEntries: number;
      postCompactTokens: number;
      preCompactTokens: number;
      reason: string;
      savedTokens: number;
      summaryChars: number;
      trigger: string;
    },
    traceContext: TraceContext,
    signal?: AbortSignal,
  ): Promise<HookRunResult>;
  injectHookAdditionalContextIntoMessageHistory(
    eventName: HookEventName,
    additionalContexts: readonly string[],
  ): RuntimeMessageEntry | undefined;
  shouldContinueAfterStopHooks(result: HookRunResult, continuationCount: number): boolean;
}
