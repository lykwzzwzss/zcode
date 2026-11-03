import { describe, expect, it } from "vitest";
import type { CompactRangeInput } from "@zcode/contracts";
import { INTERRUPT_MARKER_SOURCE, type RuntimeMessageEntry } from "../src/agent/message-history.js";
import { suggestCompactRanges } from "../src/native-context/contract.js";
import { buildCompactNudgeEntry } from "../src/runtime/methods/compact-nudge.js";
import { buildContextIndexEntry } from "../src/runtime/methods/context-index.js";
import { createTestRuntimeModel } from "./test-runtime-model.js";
import type { AgentRuntimeInternal } from "../src/runtime/internal.js";

describe("Flash compact range suggestions", () => {
  const entries: RuntimeMessageEntry[] = [
    messageEntry("system", "system"),
    messageEntry("user", "keep initial constraints", "head"),
  ];
  for (let index = 1; index <= 5; index++) {
    entries.push(messageEntry("assistant", "x".repeat(60_000), `a${index}`));
    entries.push(messageEntry("user", `request ${index}`, `u${index + 1}`));
  }
  it("suggests exact whole rounds from the latest completed large blocks and preserves the head and recent work", () => {
    const suggestions = suggestCompactRanges(entries, { minTokens: 4000, maxRanges: 2 });
    expect(suggestions.map((range) => [range.startMessageId, range.endMessageId])).toEqual([
      ["a3", "u4"],
      ["a2", "u3"],
    ]);
    const plan = planCompactRanges(entries, suggestions);
    expect(plan.ok).toBe(true);
    if (plan.ok)
      expect(plan.ranges.map((range) => [range.startMessageId, range.endMessageId])).toEqual([
        ["a2", "u3"],
        ["a3", "u4"],
      ]);
  });
  it("guides Flash toward model-written summaries rather than independent summary calls", () => {
    const runtime = { config: {} } as AgentRuntimeInternal;
    const model = createTestRuntimeModel({
      modelId: "deepseek-v4.1-flash",
      contextWindow: 1_000_000,
      generateText: async () => ({ text: "unused", finishReason: "stop", usage: {} }),
    });
    const reminder = buildCompactNudgeEntry(runtime, entries, model, [{ name: "CompactNow" }]);
    expect(reminder?.kind).toBe("attachment");
    expect(reminder?.kind === "attachment" ? reminder.content : "").toContain("ranges[].summary");
    expect(reminder?.kind === "attachment" ? reminder.content : "").toContain("a3..u4");
    expect(reminder?.kind === "attachment" ? reminder.content : "").not.toContain("SearchContext");
    expect(reminder?.kind === "attachment" ? reminder.content : "").not.toContain(
      "DecompressContext",
    );
  });
  it("does not nudge for a CompactNow tool excluded from this turn", () => {
    const runtime = { config: {} } as AgentRuntimeInternal;
    const model = createTestRuntimeModel({
      modelId: "deepseek-v4.1-flash",
      contextWindow: 1_000_000,
      generateText: async () => ({ text: "unused", finishReason: "stop", usage: {} }),
    });
    expect(buildCompactNudgeEntry(runtime, entries, model, [])).toBeUndefined();
    expect(runtime.lastCompactNudgeTokenCount).toBeUndefined();
  });
  for (const names of [
    [],
    ["CompactNow"],
    ["SearchContext"],
    ["DecompressContext"],
    ["CompactNow", "SearchContext", "DecompressContext"],
  ]) {
    it(`context index respects current tool scope: ${names.join(",") || "empty"}`, () => {
      const runtime = { config: {} } as AgentRuntimeInternal;
      const model = createTestRuntimeModel({
        modelId: "deepseek-v4.1-flash",
        contextWindow: 1_000_000,
        generateText: async () => ({ text: "unused", finishReason: "stop", usage: {} }),
      });
      const index = buildContextIndexEntry(
        runtime,
        entries,
        model,
        names.map((name) => ({ name })),
      );
      if (!names.length) {
        expect(index).toBeUndefined();
        return;
      }
      expect(index?.kind).toBe("attachment");
      const body = index?.kind === "attachment" ? index.content : "";
      for (const name of ["CompactNow", "SearchContext", "DecompressContext"]) {
        expect(body.includes(name)).toBe(names.includes(name));
      }
    });
  }
  it("does not list an interrupt marker as a user index entry", () => {
    const runtime = { config: {} } as AgentRuntimeInternal;
    const model = createTestRuntimeModel({
      modelId: "deepseek-v4.1-flash",
      contextWindow: 1_000_000,
      generateText: async () => ({ text: "unused", finishReason: "stop", usage: {} }),
    });
    const marker: RuntimeMessageEntry = {
      message: { role: "user", content: "[Request interrupted by user]" },
      messageId: "marker_entry",
      metadata: { source: INTERRUPT_MARKER_SOURCE },
    };
    const index = buildContextIndexEntry(runtime, [...entries, marker], model, [
      { name: "CompactNow" },
    ]);
    expect(index?.kind).toBe("attachment");
    const body = index?.kind === "attachment" ? index.content : "";
    expect(body).not.toContain("marker_entry");
  });
});
import {
  buildPostCompactRuntimeEntriesForRanges,
  planCompactRanges,
} from "../src/runtime/methods/compact-active-ranges.js";

/**
 * 纯函数测试：不构造 runtime 实例、不连 provider，只验证区间规划与原位替换的语义。
 * 这里直接按 RuntimeMessageEntry 的运行时形状造数据，messageId 用普通字符串即可
 * （运行时它是 branded string，纯函数只做字符串索引与回填）。
 */

function messageEntry(
  role: "system" | "user" | "assistant" | "tool",
  content: string,
  messageId?: string,
): RuntimeMessageEntry {
  return {
    message: { role, content },
    ...(messageId ? { messageId } : {}),
  };
}

function foldedSummaryEntry(content: string, messageId: string): RuntimeMessageEntry {
  return {
    message: { role: "assistant", content },
    messageId,
    metadata: {
      source: "legacy_synthetic",
      compactBoundary: { boundaryId: "compact_previous" },
    },
  };
}

function summaryEntry(content: string): RuntimeMessageEntry {
  return {
    message: { role: "user", content },
    metadata: { source: "legacy_synthetic" },
  };
}

function reminderEntry(content: string): RuntimeMessageEntry {
  return {
    kind: "attachment",
    content,
    metadata: { source: "legacy_synthetic" },
  };
}

function interruptMarkerEntry(messageId: string): RuntimeMessageEntry {
  return {
    message: { role: "user", content: "interrupted" },
    messageId,
    metadata: { source: INTERRUPT_MARKER_SOURCE },
  };
}

function range(startMessageId: string, endMessageId: string): CompactRangeInput {
  return { startMessageId, endMessageId };
}

function contentOf(entry: RuntimeMessageEntry): string {
  return entry.kind === "attachment" ? entry.content : (entry.message.content as string);
}

function plannedIndices(
  entries: readonly RuntimeMessageEntry[],
  ranges: readonly CompactRangeInput[],
) {
  const plan = planCompactRanges(entries, ranges);
  expect(plan.ok).toBe(true);
  if (!plan.ok) throw new Error(`expected plan to succeed, got ${plan.reason}: ${plan.message}`);
  return plan.ranges.map((planned) => [
    planned.startIndex,
    planned.endIndex,
    planned.startMessageId,
    planned.endMessageId,
  ]);
}

describe("planCompactRanges", () => {
  const conversation: RuntimeMessageEntry[] = [
    messageEntry("system", "system prompt"),
    messageEntry("user", "u1", "m1"),
    messageEntry("assistant", "a1", "m2"),
    messageEntry("user", "u2", "m3"),
    messageEntry("assistant", "a2", "m4"),
    messageEntry("user", "u3", "m5"),
    messageEntry("assistant", "a3", "m6"),
  ];

  it("associates submitted summaries by exact normalized endpoints, not input order", () => {
    const plan = planCompactRanges(conversation, [
      { ...range("m4", "m5"), summary: "second range" },
      { ...range("m1", "m1"), summary: "first range" },
    ]);
    expect(plan.ok).toBe(true);
    if (plan.ok)
      expect(plan.ranges.map((item) => item.summary)).toEqual(["first range", "second range"]);
  });

  it("rejects partial, expanded or merged submitted summaries instead of applying them to other content", () => {
    for (const ranges of [
      [{ ...range("m1", "m1"), summary: "one" }, range("m4", "m5")],
      [{ ...range("m4", "m4"), summary: "would omit m5" }],
      [
        { ...range("m1", "m3"), summary: "one" },
        { ...range("m2", "m3"), summary: "overlap" },
      ],
    ])
      expect(planCompactRanges(conversation, ranges)).toMatchObject({ ok: false });
  });

  it("plans multiple disjoint ranges at their original positions", () => {
    // 轮分组语义：assistant 开新轮，并吸收其后的 user/tool 消息直到下一个 assistant。
    // 因此 m1（u1）单独成轮 1..1；m4（a2）所在轮为 4..5（含 u3）。
    expect(plannedIndices(conversation, [range("m1", "m1"), range("m4", "m4")])).toEqual([
      [1, 1, "m1", "m1"],
      [4, 5, "m4", "m5"],
    ]);
  });

  it("reports unknown message ids instead of silently dropping the range", () => {
    const plan = planCompactRanges(conversation, [range("m1", "missing-end")]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("unknown_message_id");
    expect(plan.message).toContain("missing-end");
  });

  it("expands a range start to the beginning of its assistant-started round", () => {
    // a1 开启一轮，u1 属于同一轮（下一个 assistant 才开新轮）。
    // 只选 u1 时，必须把整轮 a1..u1 一起折，否则 tool/assistant 轮会被切成半截。
    const entries: RuntimeMessageEntry[] = [
      messageEntry("system", "system prompt"),
      messageEntry("assistant", "a1", "m1"),
      messageEntry("user", "u1", "m2"),
      messageEntry("assistant", "a2", "m3"),
      messageEntry("user", "u2", "m4"),
    ];
    expect(plannedIndices(entries, [range("m2", "m2")])).toEqual([[1, 2, "m1", "m2"]]);
  });

  it("merges overlapping original ranges before expanding them", () => {
    const entries: RuntimeMessageEntry[] = [
      messageEntry("system", "system prompt"),
      messageEntry("user", "u1", "m1"),
      messageEntry("assistant", "a1", "m2"),
      messageEntry("user", "u2", "m3"),
      messageEntry("assistant", "a2", "m4"),
    ];
    // 两个原始区间在 m2 处重叠：先合并成 1..3；合并后的起点落在轮 1..1、终点落在
    // a1 轮 2..3，外扩后仍是 1..3。
    expect(plannedIndices(entries, [range("m1", "m2"), range("m2", "m3")])).toEqual([
      [1, 3, "m1", "m3"],
    ]);
  });

  it("rejects expansion that would swallow an unselected gap and names the effective ranges", () => {
    const entries: RuntimeMessageEntry[] = [
      messageEntry("system", "system prompt"),
      messageEntry("assistant", "a1", "m1"),
      messageEntry("user", "u1", "m2"),
      messageEntry("user", "gap", "m3"),
      messageEntry("user", "u3", "m4"),
      messageEntry("assistant", "a2", "m5"),
    ];
    // 两个原始区间（m2、m4）之间还有 m3 未被选中；按轮外扩后两者都会覆盖整轮 1..4，
    // 此时不能静默吞掉 gap，必须拒绝并告诉用户实际会生效的区间。
    const plan = planCompactRanges(entries, [range("m2", "m2"), range("m4", "m4")]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("range_expansion_overlap");
    expect(plan.message).toContain("m1..m4");
  });

  it("rejects ranges that reach into the system context prefix", () => {
    const entries: RuntimeMessageEntry[] = [
      messageEntry("system", "system prompt", "m0"),
      messageEntry("user", "u1", "m1"),
      messageEntry("assistant", "a1", "m2"),
    ];
    const plan = planCompactRanges(entries, [range("m0", "m1")]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("invalid_range");
    expect(plan.message).toContain("context prefix");
  });

  it("accepts a stable folded summary as a recursive range member", () => {
    const entries: RuntimeMessageEntry[] = [
      messageEntry("system", "system prompt"),
      messageEntry("user", "u1", "m1"),
      foldedSummaryEntry("previous summary", "m2"),
      messageEntry("user", "u3", "m3"),
    ];
    const plan = planCompactRanges(entries, [range("m1", "m2")]);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.ranges[0]?.startIndex).toBe(1);
    expect(plan.ranges[0]?.endIndex).toBe(2);
  });

  it("keeps a user prefix outside a recursively selected user summary", () => {
    const node = foldedSummaryEntry("summary", "summary-id");
    if (node.kind !== "attachment") node.message.role = "user";
    const entries = [
      messageEntry("system", "system"),
      messageEntry("user", "keep", "keep-id"),
      node,
      messageEntry("user", "tail", "tail-id"),
    ];
    expect(plannedIndices(entries, [range("summary-id", "summary-id")])).toEqual([
      [2, 2, "summary-id", "summary-id"],
    ]);
  });

  it("keeps an interrupt marker inside its round but never treats it as a range endpoint", () => {
    const entries: RuntimeMessageEntry[] = [
      messageEntry("system", "system prompt"),
      messageEntry("assistant", "a1", "m1"),
      interruptMarkerEntry("marker-id"),
      messageEntry("user", "u1", "m2"),
      messageEntry("assistant", "a2", "m3"),
      messageEntry("user", "u2", "m4"),
    ];
    // marker 是模型不可见的隐藏 user 行：它随所在轮一起被折，但不能作为端点把整轮裁掉。
    expect(plannedIndices(entries, [range("m1", "m2")])).toEqual([[1, 3, "m1", "m2"]]);
    const plan = planCompactRanges(entries, [range("marker-id", "marker-id")]);
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.reason).toBe("unknown_message_id");
  });

  it("rejects empty and oversized range lists", () => {
    const empty = planCompactRanges(conversation, []);
    expect(empty.ok).toBe(false);
    if (!empty.ok) expect(empty.reason).toBe("invalid_range");

    const tooMany = planCompactRanges(
      conversation,
      Array.from({ length: 17 }, () => range("m1", "m2")),
    );
    expect(tooMany.ok).toBe(false);
    if (!tooMany.ok) expect(tooMany.reason).toBe("invalid_range");
  });
});

describe("buildPostCompactRuntimeEntriesForRanges", () => {
  it("replaces each range in place and keeps gaps, tail and reminders in order", () => {
    const entries: RuntimeMessageEntry[] = [
      messageEntry("system", "system prompt"),
      messageEntry("user", "u1", "m1"),
      messageEntry("assistant", "a1", "m2"),
      messageEntry("user", "gap", "m3"),
      messageEntry("user", "u2", "m4"),
      messageEntry("assistant", "a2", "m5"),
      messageEntry("user", "tail", "m6"),
    ];
    const postCompact = buildPostCompactRuntimeEntriesForRanges(
      entries,
      [
        { startIndex: 1, endIndex: 2, summaryEntry: summaryEntry("S1") },
        { startIndex: 4, endIndex: 5, summaryEntry: summaryEntry("S2") },
      ],
      [reminderEntry("R")],
    );
    expect(postCompact.map(contentOf)).toEqual(["system prompt", "S1", "gap", "S2", "tail", "R"]);
    // 原始快照不被就地修改：替换只发生在返回的新数组里。
    expect(entries[1] && contentOf(entries[1])).toBe("u1");
  });
});
