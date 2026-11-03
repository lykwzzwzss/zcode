import { describe, expect, it, vi } from "vitest";
import {
  createMessageId,
  createPartId,
  createSessionId,
  createTraceId,
  type CompactBoundaryPayload,
  type CompactRangeMetadata,
  type Logger,
  type MessageId,
  type MessageWithParts,
} from "@zcode/contracts";
import {
  compactActiveSessionMessages,
  compactSessionMessages,
} from "../src/agent/compact-session.js";
import { MessageHistoryImpl, type RuntimeMessageEntry } from "../src/agent/message-history.js";
import { hydrateMessageHistoryFromSession } from "../src/agent/session-history-hydrator.js";
import { buildProviderRequestMessages } from "../src/runtime/helpers/provider-request-messages.js";
import { buildPostCompactRuntimeEntriesForRanges } from "../src/runtime/methods/compact-active-ranges.js";
import { getLatestConversationMessageId } from "../src/runtime/helpers/conversation.js";

const sessionID = createSessionId("compact-ranges");
const model = { modelID: "model-test", providerID: "provider-test" };

function userMessage(text: string): MessageWithParts {
  const id = createMessageId(`user-${text}`);
  return {
    info: { id, sessionID, role: "user", time: { created: 1 }, agent: "zcode-agent", model },
    parts: [
      {
        id: createPartId(`text-${text}`),
        messageID: id,
        sessionID,
        type: "text",
        text,
      },
    ],
  };
}

function summaryMessage(options: {
  boundaryId: string;
  /** 显式指定被折叠区间；正常用例优先用 covers 从消息对象推导 id。 */
  covers?: { end: MessageWithParts; start: MessageWithParts };
  id: string;
  preservedSegment?: {
    anchorMessageId: MessageId;
    headMessageId: MessageId;
    tailMessageId: MessageId;
  };
  range?: CompactRangeMetadata;
  text: string;
}): MessageWithParts {
  const id = createMessageId(options.id);
  const range =
    options.range ??
    (options.covers
      ? {
          endMessageId: options.covers.end.info.id,
          startMessageId: options.covers.start.info.id,
          summaryMessageId: id,
        }
      : undefined);
  const boundary: CompactBoundaryPayload = {
    boundaryId: options.boundaryId,
    preCompactTokenCount: 10,
    summarizedMessageCount: 1,
    summaryMessageIds: [],
    traceId: createTraceId(),
    trigger: "manual",
    ...(options.preservedSegment
      ? {
          preservedSegment: {
            anchorMessageId: options.preservedSegment.anchorMessageId,
            headMessageId: options.preservedSegment.headMessageId,
            tailMessageId: options.preservedSegment.tailMessageId,
          },
        }
      : {}),
  };
  return {
    info: {
      id,
      sessionID,
      role: "user",
      time: { created: 1 },
      summary: { body: options.text, diffs: [], title: "Compact summary" },
    },
    parts: [
      {
        id: createPartId(`${options.id}-text`),
        messageID: id,
        sessionID,
        type: "text",
        text: options.text,
        synthetic: true,
      },
      {
        id: createPartId(`${options.id}-part`),
        messageID: id,
        sessionID,
        type: "compaction",
        auto: false,
        compactBoundary: boundary,
        ...(range
          ? { metadata: { compactFormat: "ranges-v1" as const, compactRange: range } }
          : {}),
      },
    ],
  };
}

function createTestLogger(warnings: Array<{ context?: unknown; message: string }>): Logger {
  const logger = {
    child: () => logger,
    debug: () => undefined,
    error: () => undefined,
    info: () => undefined,
    warn: (message: string, context?: unknown) => {
      warnings.push({ context, message });
    },
  };
  return logger as unknown as Logger;
}

function messageIds(messages: MessageWithParts[]): string[] {
  return messages.map((message) => message.info.id);
}

function persistedReminder(source: string): MessageWithParts {
  const message = userMessage(`reminder-${source}`);
  message.info = {
    ...message.info,
    synthetic: true,
    source,
    semantics: {
      origin: "agent_runtime",
      kind: source === "todo_reminder" ? "todo_reminder" : "system_reminder",
      source,
      providerVisibility: "visible",
      uiVisibility: "hidden",
      transcriptVisibility: "hidden",
    },
  } as MessageWithParts["info"];
  const part = message.parts[0]!;
  if (part.type === "text") {
    part.synthetic = true;
    part.metadata = { source, runtimeMessage: { source } };
  }
  return message;
}

function hierarchicalSummary(first: MessageWithParts, last: MessageWithParts): MessageWithParts {
  const summary = summaryMessage({
    boundaryId: "reminder-boundary",
    covers: { start: first, end: last },
    id: "reminder-summary",
    text: "RESTORED_SUMMARY",
  });
  const part = summary.parts.find((part) => part.type === "compaction")!;
  if (part.type === "compaction")
    part.metadata = {
      ...part.metadata,
      hierarchy: {
        memberMessageIds: [first.info.id, last.info.id],
        childBoundaryIds: [],
        level: 1,
        originalMessageCount: 2,
      },
    };
  return summary;
}

describe("hierarchical folds and persisted reminder identity", () => {
  for (const source of [
    "todo_reminder",
    "silent_turn_reminder",
    "goal_state_change",
    "environment",
  ]) {
    it(`replays ${source} between members using the same identity as hydration`, async () => {
      const first = userMessage("first-member"),
        last = userMessage("last-member"),
        reminder = persistedReminder(source);
      const beforeHistory = new MessageHistoryImpl();
      beforeHistory.init("system");
      await hydrateMessageHistoryFromSession({
        history: beforeHistory,
        messages: [first, reminder, last],
      });
      expect(
        beforeHistory
          .toRuntimeEntries()
          .some((entry) => entry.kind === "attachment" && entry.metadata.source === source),
      ).toBe(true);
      const summary = hierarchicalSummary(first, last),
        messages = [first, reminder, last, summary],
        before = structuredClone(messages);
      expect(
        messageIds(compactSessionMessages(messages, { includePreservedSegment: true })),
      ).toEqual([summary.info.id]);
      const history = new MessageHistoryImpl();
      history.init("system");
      await hydrateMessageHistoryFromSession({ history, messages });
      expect(JSON.stringify(history.toRuntimeEntries())).toContain("RESTORED_SUMMARY");
      expect(JSON.stringify(history.toRuntimeEntries())).not.toContain(`reminder-${source}`);
      expect(messages).toEqual(before);
    });
  }
  it("replays a pre-fix hierarchy that did not include the interrupt marker as a member", async () => {
    const first = userMessage("first-member"),
      last = userMessage("last-member"),
      marker = persistedReminder("interrupt_marker");
    // 修复前的 live marker 没有持久化 message id，hierarchy 只记 [first,last]；
    // 冷侧水合后 marker 是带 id 的可见普通 user 文本，重放不能把它当未声明消息。
    const summary = hierarchicalSummary(first, last),
      messages = [first, marker, last, summary],
      before = structuredClone(messages);
    expect(messageIds(compactSessionMessages(messages, { includePreservedSegment: true }))).toEqual([
      summary.info.id,
    ]);
    const history = new MessageHistoryImpl();
    history.init("system");
    await hydrateMessageHistoryFromSession({ history, messages });
    expect(JSON.stringify(history.toRuntimeEntries())).toContain("RESTORED_SUMMARY");
    expect(JSON.stringify(history.toRuntimeEntries())).not.toContain("reminder-interrupt_marker");
    expect(messages).toEqual(before);
  });
  for (const source of [
    "real-user",
    "background_task",
    "subagent_message",
    "goal-continuation",
    "unknown-source",
    "mixed-text",
  ]) {
    it(`rejects an unlisted ${source} even if its semantics kind says system_reminder`, () => {
      const first = userMessage("first-member"),
        last = userMessage("last-member"),
        middle = persistedReminder(source);
      if (source === "real-user" && middle.parts[0]?.type === "text")
        middle.parts[0].synthetic = false;
      if (source === "mixed-text") {
        const reminder = persistedReminder("todo_reminder");
        middle.parts = [
          ...reminder.parts,
          {
            ...userMessage("REAL_TEXT_MUST_NOT_DISAPPEAR").parts[0]!,
            id: createPartId("mixed-real"),
            messageID: middle.info.id,
          },
        ];
      }
      const summary = hierarchicalSummary(first, last),
        messages = [first, middle, last, summary],
        before = structuredClone(messages);
      expect(() => compactSessionMessages(messages, { includePreservedSegment: true })).toThrow(
        expect.objectContaining({ type: "session_corrupted" }),
      );
      expect(messages).toEqual(before);
    });
  }
  it("logs structured corruption details at error level while preserving the failure", () => {
    const first = userMessage("first-member"),
      last = userMessage("last-member"),
      middle = userMessage("undeclared-real-user");
    const error = vi.fn(),
      warn = vi.fn(),
      logger = { child: () => logger, debug: () => {}, info: () => {}, error, warn };
    expect(() =>
      compactSessionMessages([first, middle, last, hierarchicalSummary(first, last)], {
        includePreservedSegment: true,
        logger: logger as unknown as Logger,
      }),
    ).toThrow(expect.objectContaining({ type: "session_corrupted" }));
    expect(error).toHaveBeenCalledWith(
      "Failed to restore compacted session history",
      expect.objectContaining({ type: "session_corrupted", retryable: false }),
      expect.objectContaining({
        reason: expect.stringContaining("range_relink_failed"),
        boundaryCount: 1,
        sessionId: sessionID,
      }),
    );
    expect(warn).not.toHaveBeenCalled();
  });
});

describe("compact session messages", () => {
  it("keeps legacy-only sessions byte-identical to the old last-boundary algorithm", () => {
    const u1 = userMessage("u1");
    const u2 = userMessage("u2");
    const legacy = summaryMessage({ boundaryId: "b1", id: "legacy-summary", text: "legacy" });
    const messages = [u1, u2, legacy];

    const rewritten = compactSessionMessages(messages, { includePreservedSegment: true });
    const legacyResult = compactActiveSessionMessages(messages, 2, true);

    expect(messageIds(rewritten)).toEqual(messageIds(legacyResult));
    expect(messageIds(rewritten)).toEqual([legacy.info.id]);
  });

  it("replays multiple ranges in write order and keeps gaps untouched", () => {
    const u1 = userMessage("u1");
    const u2 = userMessage("u2");
    const u3 = userMessage("u3");
    const u4 = userMessage("u4");
    const u5 = userMessage("u5");
    const first = summaryMessage({
      boundaryId: "b1",
      covers: { end: u2, start: u1 },
      id: "range-1-summary",
      text: "r1",
    });
    const second = summaryMessage({
      boundaryId: "b2",
      covers: { end: u5, start: u4 },
      id: "range-2-summary",
      text: "r2",
    });
    // 存储是 append-only：摘要消息物理上追加在日志末尾，range 记录指向原始消息 id。
    const messages = [u1, u2, u3, u4, u5, first, second];

    const rewritten = compactSessionMessages(messages, { includePreservedSegment: true });

    expect(messageIds(rewritten)).toEqual([first.info.id, u3.info.id, second.info.id]);
  });

  it("treats adjacent ranges as independent replacements", () => {
    const u1 = userMessage("u1");
    const u2 = userMessage("u2");
    const u3 = userMessage("u3");
    const first = summaryMessage({
      boundaryId: "b1",
      covers: { end: u1, start: u1 },
      id: "adjacent-1",
      text: "r1",
    });
    const second = summaryMessage({
      boundaryId: "b2",
      covers: { end: u2, start: u2 },
      id: "adjacent-2",
      text: "r2",
    });

    const rewritten = compactSessionMessages([u1, u2, u3, first, second], {
      includePreservedSegment: true,
    });

    expect(messageIds(rewritten)).toEqual([first.info.id, second.info.id, u3.info.id]);
  });

  it("rejects a missing range endpoint without returning uncut history", async () => {
    const u1 = userMessage("u1");
    const u2 = userMessage("u2");
    const summary = summaryMessage({
      boundaryId: "b1",
      id: "missing-end",
      range: {
        endMessageId: createMessageId("does-not-exist"),
        startMessageId: u1.info.id,
        summaryMessageId: createMessageId("missing-end"),
      },
      text: "r1",
    });
    const messages = [u1, u2, summary];
    const warnings: Array<{ context?: unknown; message: string }> = [];

    const before = structuredClone(messages);
    expect(() =>
      compactSessionMessages(messages, {
        includePreservedSegment: true,
        logger: createTestLogger(warnings),
      }),
    ).toThrow(
      expect.objectContaining({
        type: "session_corrupted",
        retryable: false,
        context: { reason: expect.stringContaining("range_relink_failed"), boundaryCount: 1 },
      }),
    );
    // 没有 logger 的恢复入口也必须收到失败；不能靠日志存在与否决定是否暴露损坏。
    const history = new MessageHistoryImpl();
    history.init("system prompt");
    const beforeEntries = history.toRuntimeEntries();
    await expect(hydrateMessageHistoryFromSession({ history, messages })).rejects.toMatchObject({
      type: "session_corrupted",
    });
    expect(history.toRuntimeEntries()).toEqual(beforeEntries);
    expect(messages).toEqual(before);
    expect(warnings).toHaveLength(0);
  });

  it("rejects overlapping or nested undeclared ranges", () => {
    const u1 = userMessage("u1");
    const u2 = userMessage("u2");
    const u3 = userMessage("u3");
    const u4 = userMessage("u4");
    const first = summaryMessage({
      boundaryId: "b1",
      covers: { end: u3, start: u1 },
      id: "overlap-1",
      text: "r1",
    });
    const second = summaryMessage({
      boundaryId: "b2",
      covers: { end: u4, start: u2 },
      id: "overlap-2",
      text: "r2",
    });
    const messages = [u1, u2, u3, u4, first, second];
    const warnings: Array<{ context?: unknown; message: string }> = [];

    expect(() =>
      compactSessionMessages(messages, {
        includePreservedSegment: true,
        logger: createTestLogger(warnings),
      }),
    ).toThrow(expect.objectContaining({ type: "session_corrupted" }));
    expect(warnings).toHaveLength(0);
  });

  it("finds the conversation anchor from an already restored timeline without replaying ranges twice", () => {
    const original = userMessage("anchor-original");
    const summary = summaryMessage({
      boundaryId: "anchor-b",
      id: "anchor-summary",
      text: "summary",
      covers: { start: original, end: original },
    });
    const active = compactSessionMessages([original, summary], { includePreservedSegment: false });
    expect(messageIds(active)).toEqual([summary.info.id]);
    expect(getLatestConversationMessageId(active)).toBe(summary.info.id);
  });

  it("replays a legacy prefix fold before later ranges", () => {
    const u1 = userMessage("u1");
    const u2 = userMessage("u2");
    const u3 = userMessage("u3");
    const legacy = summaryMessage({ boundaryId: "legacy", id: "legacy-summary", text: "legacy" });
    const u4 = userMessage("u4");
    const u5 = userMessage("u5");
    const summary = summaryMessage({
      boundaryId: "b1",
      covers: { end: u5, start: u4 },
      id: "range-summary",
      text: "r1",
    });

    const rewritten = compactSessionMessages([u1, u2, u3, legacy, u4, u5, summary], {
      includePreservedSegment: true,
    });

    // legacy 记录没有 kept 声明：它之前的所有消息都被折叠，但 legacy 摘要和 range 摘要都要留下。
    expect(messageIds(rewritten)).toEqual([legacy.info.id, summary.info.id]);
  });

  it("re-inserts a legacy preserved segment before replaying mixed ranges", () => {
    const preserved = userMessage("preserved");
    const u1 = userMessage("u1");
    const legacy = summaryMessage({
      boundaryId: "legacy",
      id: "legacy-summary",
      preservedSegment: {
        anchorMessageId: createMessageId("legacy-summary"),
        headMessageId: preserved.info.id,
        tailMessageId: preserved.info.id,
      },
      text: "legacy",
    });
    const u2 = userMessage("u2");
    const summary = summaryMessage({
      boundaryId: "b1",
      covers: { end: u2, start: u2 },
      id: "range-summary",
      text: "r1",
    });
    const messages = [preserved, u1, legacy, u2, summary];

    const withPreserved = compactSessionMessages(messages, { includePreservedSegment: true });
    const withoutPreserved = compactSessionMessages(messages, { includePreservedSegment: false });

    expect(messageIds(withPreserved)).toEqual([legacy.info.id, preserved.info.id, summary.info.id]);
    // rewind 等调用方明确要求不重放保留段时，只保留 legacy 摘要本体。
    expect(messageIds(withoutPreserved)).toEqual([legacy.info.id, summary.info.id]);
  });

  it("rejects a declared summary id that does not match its boundary message", () => {
    const u1 = userMessage("u1");
    const summary = summaryMessage({
      boundaryId: "b1",
      id: "mismatch",
      range: {
        endMessageId: u1.info.id,
        startMessageId: u1.info.id,
        summaryMessageId: createMessageId("another-summary"),
      },
      text: "r1",
    });
    const messages = [u1, summary];
    const warn = vi.fn();
    const logger = {
      child: () => logger,
      debug: () => undefined,
      error: () => undefined,
      info: () => undefined,
      warn,
    };

    expect(() =>
      compactSessionMessages(messages, {
        includePreservedSegment: true,
        logger: logger as unknown as Logger,
      }),
    ).toThrow(expect.objectContaining({ type: "session_corrupted" }));
    expect(warn).not.toHaveBeenCalled();
  });

  it("hydrates persisted range summaries in original message order", async () => {
    const u1 = userMessage("h1");
    const u2 = userMessage("h2");
    const u3 = userMessage("h3");
    const first = summaryMessage({
      boundaryId: "b1",
      covers: { end: u1, start: u1 },
      id: "hydrate-range-1",
      text: "summary-one",
    });
    const second = summaryMessage({
      boundaryId: "b2",
      covers: { end: u2, start: u2 },
      id: "hydrate-range-2",
      text: "summary-two",
    });
    const history = new MessageHistoryImpl();
    history.init("system prompt");

    await hydrateMessageHistoryFromSession({
      history,
      messages: [u1, u2, u3, first, second],
    });

    const providerMessages = buildProviderRequestMessages({
      entries: history.toRuntimeEntries(),
    }).messages;
    const rendered = providerMessages
      .map((message) => (typeof message.content === "string" ? message.content : "[]"))
      .join("\n");

    expect(rendered).toContain("summary-one");
    expect(rendered).toContain("summary-two");
    expect(rendered.indexOf("summary-one")).toBeLessThan(rendered.indexOf("summary-two"));
    // 被折叠的原文与未选中的尾部都必须按原位语义恢复。
    expect(rendered).not.toContain("h1");
    expect(rendered).not.toContain("h2");
    expect(rendered).toContain("h3");
  });

  it("live ranges chain and hydrated cold chain agree message-for-message", async () => {
    const u1 = userMessage("eq-1");
    const u2 = userMessage("eq-2");
    const u3 = userMessage("eq-3");
    const s1 = summaryMessage({
      boundaryId: "eq-boundary-1",
      covers: { end: u1, start: u1 },
      id: "eq-range-1",
      text: "eq summary one",
    });
    const s2 = summaryMessage({
      boundaryId: "eq-boundary-2",
      covers: { end: u3, start: u3 },
      id: "eq-range-2",
      text: "eq summary two",
    });

    // live：折叠前链上原位替换两段，gap（u2）原样保留。
    const liveHistory = new MessageHistoryImpl();
    liveHistory.init("system prompt");
    await hydrateMessageHistoryFromSession({ history: liveHistory, messages: [u1, u2, u3] });
    const before = liveHistory.toRuntimeEntries();
    const indexOf = (message: MessageWithParts) =>
      before.findIndex(
        (entry) => entry.kind !== "attachment" && entry.messageId === message.info.id,
      );
    const summaryEntry = (id: string, text: string): RuntimeMessageEntry =>
      ({ message: { content: text, role: "user" }, messageId: id }) as RuntimeMessageEntry;
    const live = buildPostCompactRuntimeEntriesForRanges(before, [
      {
        endIndex: indexOf(u1),
        startIndex: indexOf(u1),
        summaryEntry: summaryEntry(s1.info.id, "eq summary one"),
      },
      {
        endIndex: indexOf(u3),
        startIndex: indexOf(u3),
        summaryEntry: summaryEntry(s2.info.id, "eq summary two"),
      },
    ]);

    // cold：同一次操作落盘后的形状（原文 + 两条 summary 追加在物理末尾）经 hydrate 重建。
    const coldHistory = new MessageHistoryImpl();
    coldHistory.init("system prompt");
    await hydrateMessageHistoryFromSession({
      history: coldHistory,
      messages: [u1, u2, u3, s1, s2],
    });
    const cold = coldHistory.toRuntimeEntries();

    const ids = (entries: readonly RuntimeMessageEntry[]) =>
      entries.flatMap((entry) =>
        entry.kind === "attachment" || !entry.messageId ? [] : [entry.messageId],
      );
    expect(ids(live)).toEqual(ids(cold));
    expect(ids(live)).toEqual([s1.info.id, u2.info.id, s2.info.id]);
  });
});
