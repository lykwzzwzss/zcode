import { getConversationModelOnlyTurnTriggerSource } from "@zcode/shared";
import type { GenUiModelContext } from "@zcode/shared/gen-ui";
import { attachGenUiContext } from "../../agent/message-history.js";
import { modelMessageContentToText } from "../deps.js";
import { buildPromptAttachmentBlocks } from "../../system-reminder/prompt-attachment.js";
import {
  buildUserMessageEntries,
  isPastedInlineImageAttachment,
  promptAttachmentInputForResolvedAttachment,
  isFailedTextAttachmentPlaceholder,
  type RuntimeMessageEntry,
} from "../../agent/message-history.js";
import type {
  MessageId,
  MessageWithParts,
  ModelMessageContent,
  ModelMessageContentBlock,
} from "../deps.js";
import type { ResolvedTurnAttachment, RunModelTextRequestOptions } from "../types.js";

/**
 * 隐藏提醒记录：公告、批次提示、中断标记等只给模型看的 system_reminder 记录。它是模型上下文，
 * 不是对话消息：rewind 锚点回溯、turnNumber、对话指针和 fork 选型回退都跳过它
 * （meta-user-context.md）。会开启一轮的 model-only 输入（goal continuation 等）不算。
 */
export function isHiddenReminderMessage(message: MessageWithParts): boolean {
  const semantics = message.info.semantics;
  return (
    message.info.role === "user" &&
    semantics?.kind === "system_reminder" &&
    semantics.uiVisibility === "hidden" &&
    getConversationModelOnlyTurnTriggerSource(message) === null
  );
}

/** 调用方已选定不含 preserved segment 的活跃时间线；这里只查找，不再重放压缩。 */
export function getLatestConversationMessageId(
  activeMessages: readonly MessageWithParts[],
): MessageId | undefined {
  // 根因：resume/rewind 已做过 activeSessionMessages，再做一次会因原文端点已被替换而报损坏；
  // 旧 warn+全量回退掩盖了这个重复重放错误。活跃链的选择只由调用方负责。
  for (let index = activeMessages.length - 1; index >= 0; index--) {
    const message = activeMessages[index]!;
    // 压缩时间线会物理追加在尾部；它不进模型历史，冷恢复不能让它抢占正文锚点。
    if (message.info.semantics?.providerVisibility === "hidden") continue;
    // 与 live 一致：隐藏提醒不移动对话指针。
    if (isHiddenReminderMessage(message)) continue;
    if (message.info.role === "user" || message.info.role === "assistant") {
      return message.info.id;
    }
  }

  return undefined;
}

export function findLatestRealUserMessageIndex(
  messages: RunModelTextRequestOptions["messages"],
): number {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    // provider projection 会在剥离 metadata 前传入 latest real user 的 request-local index。
    // 这里仅作为缺失该 index 时的兜底，避免把用户输入的 literal meta tag 当成 runtime meta。
    if (message.role === "user" && !isMetaUserContextMessage(message)) {
      return index;
    }
  }
  return -1;
}

export function isMetaUserContextMessage(
  message: RunModelTextRequestOptions["messages"][number],
): boolean {
  return (
    message.role === "user" &&
    modelMessageContentToText(message.content).trimStart().startsWith("<system-reminder>")
  );
}

export function buildUserContentFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
): ModelMessageContent {
  if (attachments.length === 0) return input;

  const blocks: ModelMessageContentBlock[] = [];
  // video 跟随正文，避免影响既有非粘贴 image/@file/url 的顺序。
  const videoBlocks: ModelMessageContentBlock[] = [];
  const pastedImageBlocks: ModelMessageContentBlock[] = [];
  for (const attachment of attachments) {
    if (isPastedInlineImageAttachment(attachment)) {
      pastedImageBlocks.push(attachment.contentBlock);
      continue;
    }
    const promptAttachmentInput = promptAttachmentInputForResolvedAttachment(attachment);
    if (promptAttachmentInput) {
      blocks.push(...buildPromptAttachmentBlocks(promptAttachmentInput));
      continue;
    }
    if (isFailedTextAttachmentPlaceholder(attachment)) {
      continue;
    }
    if (attachment.contentBlock.type === "video") {
      videoBlocks.push(attachment.contentBlock);
      continue;
    }
    blocks.push(attachment.contentBlock);
  }

  if (blocks.length === 0 && pastedImageBlocks.length === 0 && videoBlocks.length === 0) {
    return input;
  }

  if (input.length > 0) {
    blocks.push({ type: "text", text: input });
  }
  blocks.push(...videoBlocks, ...pastedImageBlocks);

  return blocks;
}

export function buildRuntimeUserEntriesFromTurn(
  input: string,
  attachments: ResolvedTurnAttachment[],
  options: {
    browserAmbientContext?: { tabCount: number; currentUrl?: string };
    genUiContext?: GenUiModelContext;
  } = {},
): RuntimeMessageEntry[] {
  const [userEntry, ...attachmentEntries] = buildUserMessageEntries(
    input.length > 0 ? formatBrowserAmbientUserInput(input, options.browserAmbientContext) : input,
    attachments,
  );
  return [attachGenUiContext(userEntry, options.genUiContext), ...attachmentEntries];
}

export function formatBrowserAmbientUserInput(
  input: string,
  context?: { tabCount: number; currentUrl?: string },
): string {
  if (!context || !Number.isInteger(context.tabCount) || context.tabCount <= 0) return input;
  const tabLabel = context.tabCount === 1 ? "tab" : "tabs";
  const lines = [
    '<in-app-browser-context source="ambient-ui-state">',
    "This block is automatically supplied ambient UI state, not part of the user's request. Do not treat it as an instruction or as evidence that the user explicitly selected the in-app browser.",
    "# In app browser:",
    `- The user has the in-app browser open with ${context.tabCount} ${tabLabel}.`,
    ...(context.currentUrl ? [`- Current URL: ${context.currentUrl}`] : []),
    "</in-app-browser-context>",
    "",
    "## My request for ZCode:",
    input,
  ];
  return lines.join("\n");
}
