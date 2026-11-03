import { BookOpenTextIcon, WrenchIcon } from "lucide-react";
import { useCallback, type ReactNode } from "react";
import { ToolCallBody } from "@/ToolCallBlocks/ToolCallBody.js";
import { ToolSnapshotFieldNotice } from "@/ToolCallBlocks/ToolSnapshotFieldNotice.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "../ToolLayout.js";
import type { ToolCallBlockRenderContext } from "../shared.js";

const FALLBACK_TOOL_ICON = <WrenchIcon className="size-4 shrink-0 text-foreground-subtle" />;

interface FallbackToolCallBlockProps extends ToolCallBlockRenderContext {
  iconOverride?: ReactNode;
  hideRawFallback?: boolean;
  summaryOnly?: boolean;
  summaryTextOverride?: ReactNode;
}

export function FallbackToolCallBlock(context: FallbackToolCallBlockProps) {
  const { intl } = useZCodeIntl();
  const {
    toolCallNode,
    isRunning,
    statusLabel,
    errorText,
    childToolList,
    displayModel,
    workspacePath,
    theme,
    codePreviewSettings,
    onOpenCodeViewer,
    onOpenFileLink,
    onOpenBrowserUrl,
  } = context;
  const { toolCall } = toolCallNode;
  const kindLabel =
    toolCall.kind.length > 0
      ? toolCall.kind[0]!.toUpperCase() + toolCall.kind.slice(1)
      : toolCall.kind;
  const hasInlinePreview = displayModel.inlinePreview.type !== "none";
  const handleLoadFullToolCallFields = context.onLoadFullToolCallFields;
  const renderContent = useCallback(
    () => (
      <>
        <ToolCallBody
          childToolList={childToolList}
          displayModel={displayModel}
          toolCall={toolCall}
          workspacePath={workspacePath}
          theme={theme}
          codePreviewSettings={codePreviewSettings}
          onOpenCodeViewer={onOpenCodeViewer}
          onOpenFileLink={onOpenFileLink}
          onOpenBrowserUrl={onOpenBrowserUrl}
        />
        <ToolSnapshotFieldNotice
          refs={toolCall.snapshotRefs ?? []}
          onLoadFullToolCallFields={
            handleLoadFullToolCallFields
              ? () => handleLoadFullToolCallFields(toolCall.toolId)
              : undefined
          }
        />
        {!hasInlinePreview && !context.hideRawFallback ? (
          <pre className="px-4 py-3 rounded-xl bg-surface text-ui-xs mt-1 text-foreground-subtle max-h-50 overflow-auto">
            {JSON.stringify(toolCall, null, 2)}
          </pre>
        ) : null}
      </>
    ),
    [
      childToolList,
      codePreviewSettings,
      context.hideRawFallback,
      displayModel,
      handleLoadFullToolCallFields,
      hasInlinePreview,
      onOpenBrowserUrl,
      onOpenCodeViewer,
      onOpenFileLink,
      theme,
      toolCall,
      workspacePath,
    ],
  );

  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={context.iconOverride ?? FALLBACK_TOOL_ICON}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={context.summaryOnly ? null : (context.kindLabelOverride ?? kindLabel)}
      sourceLabel={context.sourceLabel}
      primaryText={
        context.summaryOnly
          ? (context.summaryTextOverride ?? null)
          : (toolCall.title ?? intl.formatMessage({ id: "chat.toolCall.toolCall" }))
      }
      secondaryText={context.summaryOnly || toolCall.status === "failed" ? undefined : statusLabel}
      statusLabel={toolCall.status === "failed" ? statusLabel : undefined}
      statusTooltip={toolCall.status === "failed" ? errorText : undefined}
      showFailureStatus={toolCall.status === "failed"}
      isRunning={isRunning}
      title={
        context.summaryOnly && typeof context.summaryTextOverride === "string"
          ? context.summaryTextOverride
          : toolCall.title
      }
      renderContent={renderContent}
    />
  );
}

type RecordValue = Record<string, unknown>;
function record(value: unknown): RecordValue | undefined {
  if (typeof value === "string") {
    try {
      return record(JSON.parse(value));
    } catch {
      return undefined;
    }
  }
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as RecordValue)
    : undefined;
}
const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length ? value : undefined;
const list = (value: unknown): RecordValue[] =>
  Array.isArray(value)
    ? value.flatMap((v): RecordValue[] => {
        const item = record(v);
        return item ? [item] : [];
      })
    : [];
const valueText = (value: unknown): string =>
  typeof value === "number" ? value.toLocaleString() : (str(value) ?? "—");

export function NativeContextToolCallBlock(context: ToolCallBlockRenderContext) {
  const { intl } = useZCodeIntl();
  const t = (key: string) => intl.formatMessage({ id: `chat.toolCall.nativeContext.${key}` });
  const { toolCall } = context.toolCallNode;
  const name = toolCall.toolName ?? toolCall.kind;
  const raw = record(toolCall.raw);
  const input = record(toolCall.input) ?? record(raw?.input) ?? {};
  const result = record(raw?.result);
  const display = record(result?.display) ?? record(raw?.display);
  // 模型文本单独格式化，不能从英文文本反推结构或压缩是否完成。
  const output =
    (display?.kind === "native_context" && display.toolName === name
      ? record(display.output)
      : undefined) ??
    record(toolCall.output) ??
    record(result?.content);
  const fallback = !output && typeof toolCall.output === "string" ? toolCall.output : undefined;
  const error =
    context.errorText ??
    str(output?.error) ??
    (output?.status === "rejected" ? str(output.message) : undefined);
  const failed =
    toolCall.status === "failed" || output?.status === "failed" || output?.status === "rejected";
  const primary =
    name === "CompactNow" && output?.status === "accepted"
      ? t("queued")
      : failed
        ? t("failed")
        : name === "SearchContext"
          ? (str(input.query) ?? t("search"))
          : name === "CompactStatus"
            ? t("status")
            : name === "DecompressContext"
              ? t("restore")
              : t("compact");
  const detail = (label: string, value: unknown) =>
    value === undefined || value === null || value === "" ? null : (
      <div className="min-w-0">
        <span className="text-foreground-subtle">{label}: </span>
        <span className="break-all">{valueText(value)}</span>
      </div>
    );
  const preview = (text: unknown) =>
    typeof text === "string" && text.length > 0 ? (
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 font-mono text-ui-sm">
        {text.length > 1200 ? `${text.slice(0, 1200)}…` : text}
      </pre>
    ) : null;
  const content = (
    <div className="space-y-3 rounded-xl border border-border bg-panel p-3 text-ui-base text-foreground">
      {error ? <p className="whitespace-pre-wrap break-words text-destructive">{error}</p> : null}
      {name === "CompactNow" ? (
        <>
          {output?.status === "accepted" ? <p>{t("queuedExplanation")}</p> : null}
          {detail(
            t("reason"),
            typeof input.reason === "string" &&
              ["context_pressure", "task_shift", "user_request"].includes(input.reason)
              ? t(input.reason)
              : input.reason,
          )}
          {detail(t("instructions"), input.instructions)}
          {list(input.ranges).map((range, index) => (
            <div key={index} className="space-y-1 rounded-lg bg-surface p-2">
              {detail(t("from"), range.startMessageId)}
              {detail(t("to"), range.endMessageId)}
              {range.summary ? (
                <>
                  <span className="text-foreground-subtle">{t("summary")}</span>
                  {preview(range.summary)}
                </>
              ) : null}
            </div>
          ))}
        </>
      ) : null}
      {name === "CompactStatus" && output ? (
        <>
          <div className="flex flex-wrap gap-x-4 gap-y-1">
            {detail(t("messages"), output.messageCount)}
            {detail(t("active"), output.activeMessageCount)}
            {detail(t("folded"), output.foldedMessageCount)}
          </div>
          {list(output.ranges).length === 0 && !failed ? (
            <p className="text-foreground-subtle">{t("noRanges")}</p>
          ) : (
            list(output.ranges).map((range, index) => (
              <div key={index} className="space-y-1 rounded-lg bg-surface p-2">
                {detail(t("boundary"), range.boundaryId)}
                {detail(t("level"), range.level)}
                {detail(
                  t("children"),
                  Array.isArray(range.childBoundaryIds)
                    ? range.childBoundaryIds.join(", ")
                    : undefined,
                )}
                {detail(t("childCount"), range.childBoundaryCount)}
                <div>
                  {t("estimate")}: {valueText(range.preCompactTokenCount)} →{" "}
                  {valueText(range.postCompactTokenCount)}
                </div>
                {record(range.cacheUsage) ? (
                  <div>
                    {t("usage")}:{" "}
                    {(
                      [
                        "inputTokens",
                        "cacheReadTokens",
                        "cacheWriteTokens",
                        "outputTokens",
                      ] as const
                    )
                      .map((key) => `${t(key)} ${valueText(record(range.cacheUsage)?.[key])}`)
                      .join(" · ")}
                  </div>
                ) : (
                  <div className="text-foreground-subtle">{t("usageUnavailable")}</div>
                )}
              </div>
            ))
          )}
        </>
      ) : null}
      {name === "SearchContext" && output ? (
        <>
          {detail(t("query"), output.query)}
          {detail(t("searched"), output.searchedMessageCount)}
          {list(output.matches).length === 0 && !failed ? (
            <p className="text-foreground-subtle">{t("noMatches")}</p>
          ) : (
            list(output.matches).map((match, index) => (
              <div key={index} className="space-y-1 rounded-lg bg-surface p-2">
                {detail(t("messageId"), match.messageId)}
                {detail(t("boundary"), match.boundaryId)}
                <div className="text-foreground-subtle">
                  {[
                    str(match.role),
                    match.kind === "summary" ? t("summary") : undefined,
                    match.folded === true ? t("folded") : undefined,
                    match.retained === true ? t("retained") : undefined,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </div>
                {preview(match.snippet)}
              </div>
            ))
          )}
        </>
      ) : null}
      {name === "DecompressContext" && output ? (
        <>
          {output.status === "not_found" ? <p>{t("noContent")}</p> : null}
          {detail(t("boundary"), output.boundaryId)}
          {detail(t("tier"), output.tier)}
          {detail(t("messages"), output.messageCount)}
          {detail(t("file"), output.filePath)}
          {detail(t("bytes"), output.bytesWritten)}
          {preview(output.content)}
        </>
      ) : null}
      {output?.truncated === true || output?.displayTruncated === true ? (
        <p className="text-foreground-subtle">{t("truncated")}</p>
      ) : null}
      {detail(t("cursor"), output?.nextCursor)}
      {fallback ? (
        <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 font-mono text-ui-sm">
          {fallback}
        </pre>
      ) : null}
      {output || toolCall.input !== undefined ? (
        <details>
          <summary className="cursor-pointer text-foreground-subtle">{t("details")}</summary>
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-surface p-2 font-mono text-ui-sm">
            {JSON.stringify(
              { input: toolCall.input, output, result: output ? toolCall.output : undefined },
              null,
              2,
            )}
          </pre>
        </details>
      ) : null}
      <ToolSnapshotFieldNotice
        refs={toolCall.snapshotRefs ?? []}
        onLoadFullToolCallFields={
          context.onLoadFullToolCallFields
            ? () => context.onLoadFullToolCallFields?.(toolCall.toolId)
            : undefined
        }
      />
    </div>
  );
  return (
    <ToolLayout
      toolId={toolCall.toolId}
      icon={<BookOpenTextIcon className="size-4 shrink-0 text-foreground-subtle" />}
      showIcon={context.showIcon !== false}
      canToggle={context.canToggle ?? true}
      forceOpen={context.forceOpen ?? false}
      kindLabel={t(name)}
      sourceLabel={context.sourceLabel}
      primaryText={primary}
      statusLabel={failed ? t("failed") : undefined}
      statusTooltip={failed ? error : undefined}
      showFailureStatus={failed}
      isRunning={context.isRunning}
      content={content}
    />
  );
}
