import type { MessagePart } from "@zcode/contracts";
import {
  getSystemReminderDescriptor,
  type SystemReminderSource,
} from "../../system-reminder/source.js";
import { hydrateToolSearchAnnouncement } from "../tool-search-hydration.js";
import { parseToolSearchHiddenNames } from "../../tool/search/history.js";
import { parseAgentListingDelta } from "../agent-listing-metadata.js";
import { parseEnvironmentAnnouncement } from "../../context/sections/env-info.js";
import { runtimeInputMetadata } from "../runtime-input-presentation.js";
import {
  INTERRUPT_MARKER_SOURCE,
  isKnownSystemReminderSource,
  legacySyntheticRuntimeMetadata,
  realUserRuntimeMetadata,
  systemReminderAttachmentEntry,
  systemReminderRuntimeMetadata,
  todoReminderRuntimeMetadata,
  type RuntimeMessageMetadata,
  type RuntimeMessageSource,
} from "../message-history.js";

export function dedupeParts(parts: MessagePart[]): MessagePart[] {
  const byId = new Map<string, MessagePart>();
  for (const part of parts) {
    byId.set(part.id, part);
  }
  return [...byId.values()];
}

type SyntheticSystemReminderAttachment = ReturnType<typeof systemReminderAttachmentEntry>;

export function syntheticSystemReminderAttachmentFromParts(
  parts: MessagePart[],
): SyntheticSystemReminderAttachment | undefined {
  const visibleParts = dedupeParts(parts).filter((part) => !(part.type === "text" && part.ignored));
  if (visibleParts.length !== 1) return undefined;

  const part = visibleParts[0]!;
  if (part.type !== "text" || !part.synthetic) return undefined;
  return syntheticSystemReminderAttachmentFromTextPart(part);
}

export function syntheticSystemReminderAttachmentFromTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): SyntheticSystemReminderAttachment | undefined {
  if (!part.synthetic) return undefined;
  if (part.text.trim().length === 0) return undefined;
  const metadata = metadataFromSyntheticTextPart(part);
  // 只凭已校验的公告身份适配旧包装，不从普通用户正文推断提醒来源。
  const announcement = metadata.toolSearchAnnouncement;
  const wrapped = isProviderWrappedSystemReminderText(part.text);
  if (wrapped && !announcement) return undefined;
  if (!isRestorableSystemReminderAttachmentSource(metadata.source)) return undefined;

  return {
    ...systemReminderAttachmentEntry(
      metadata.source,
      wrapped && announcement
        ? part.text
            .trim()
            .replace(/^<system-reminder>\s*/, "")
            .replace(/\s*<\/system-reminder>$/, "")
        : part.text,
    ),
    metadata,
  };
}

function isRestorableSystemReminderAttachmentSource(
  source: RuntimeMessageSource,
): source is SystemReminderSource {
  if (!isKnownSystemReminderSource(source)) return false;
  const descriptor = getSystemReminderDescriptor(source);
  return (
    descriptor.isMeta &&
    descriptor.providerVisibility === "provider_visible" &&
    descriptor.channel !== "real_user" &&
    descriptor.channel !== "tool_result"
  );
}

export function isProviderWrappedSystemReminderText(text: string): boolean {
  return text.trimStart().startsWith("<system-reminder");
}

export function metadataFromSyntheticTextPart(
  part: Extract<MessagePart, { type: "text" }>,
): RuntimeMessageMetadata {
  const source = part.metadata?.source;
  if (source === "background_task" || source === "subagent_message") {
    // runtime command carrier 对齐直接 user-like 注入；即使旧持久化里带过
    // system reminder metadata，恢复时也不能把后台完成或 child 回复重新包成 reminder。
    return legacySyntheticRuntimeMetadata();
  }

  const persistedRuntimeMetadata = runtimeMessageMetadataFromPartMetadata(part.metadata);
  if (persistedRuntimeMetadata) {
    return persistedRuntimeMetadata;
  }

  if (source === "subagent") {
    return systemReminderRuntimeMetadata("queued_system_notification");
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (source === "goal-continuation") {
    return systemReminderRuntimeMetadata("target_continuation");
  }
  if (source === "rewind" || source === "fork") {
    return systemReminderRuntimeMetadata("rewind_notice");
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return legacySyntheticRuntimeMetadata();
}

export function runtimeMessageMetadataFromPartMetadata(
  metadata: Record<string, unknown> | undefined,
): RuntimeMessageMetadata | undefined {
  const runtimeMessage = metadata?.runtimeMessage;
  if (!isRecord(runtimeMessage)) return undefined;

  const presentation = runtimeInputMetadata(runtimeMessage.inputPresentation);
  if (presentation) return presentation;
  const source = runtimeMessage.source;
  if (source === "environment") {
    const environment = parseEnvironmentAnnouncement(runtimeMessage.environment);
    return { source, ...(environment ? { environment } : {}) };
  }
  if (source === "agent_listing_delta") {
    const delta = parseAgentListingDelta(runtimeMessage.agentListingDelta);
    return { source, ...(delta ? { agentListingDelta: delta } : {}) };
  }
  if (source === "real_user") {
    return realUserRuntimeMetadata();
  }
  if (source === INTERRUPT_MARKER_SOURCE) return { source };
  if (source === "legacy_synthetic" || source === "tool_search_announcement") {
    const announcement = hydrateToolSearchAnnouncement(runtimeMessage.toolSearchAnnouncement);
    const hiddenNames =
      announcement &&
      parseToolSearchHiddenNames(runtimeMessage.toolSearchHiddenNames, announcement);
    return {
      ...legacySyntheticRuntimeMetadata(),
      ...(announcement
        ? { source: "tool_search_announcement" as const, toolSearchAnnouncement: announcement }
        : {}),
      ...(hiddenNames ? { toolSearchHiddenNames: hiddenNames } : {}),
    };
  }
  if (source === "todo_reminder") {
    return todoReminderRuntimeMetadata();
  }
  if (isKnownSystemReminderSource(source)) {
    return systemReminderRuntimeMetadata(source);
  }

  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
