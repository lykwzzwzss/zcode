import { describe, expect, it } from "vitest";
import type { CompactStatusOutput } from "@zcode/contracts";
import { compactStatusToolEntry } from "../src/tool/handlers/compact-status.js";

function render(output: CompactStatusOutput): string {
  const rendered = compactStatusToolEntry.formatModelContent?.(output);
  expect(typeof rendered).toBe("string");
  return rendered as string;
}

const baseOutput = {
  activeMessageCount: 9,
  foldedMessageCount: 11,
  messageCount: 20,
  sessionId: "sess_compact_status",
} satisfies Partial<CompactStatusOutput>;

describe("formatCompactStatus", () => {
  it("reports a failed read instead of zero counts", () => {
    const text = render({
      ...baseOutput,
      activeMessageCount: 0,
      error: "session store unavailable",
      foldedMessageCount: 0,
      messageCount: 0,
      ranges: [],
      status: "failed",
    });

    expect(text).toContain("compaction state unavailable");
    expect(text).toContain("session store unavailable");
    expect(text).not.toContain("0 persisted");
  });

  it("labels per-dimension fold cost coverage when folds report different fields", () => {
    const text = render({
      ...baseOutput,
      lastCompactAt: 2,
      ranges: [
        {
          boundaryId: "compact_a",
          cacheUsage: { inputTokens: 1000 },
          createdAt: 1,
          lastSummarizedMessageId: "msg_a",
          messageId: "msg_a",
          postCompactTokenCount: 100,
          preCompactTokenCount: 1000,
          summarizedMessageCount: 5,
        },
        {
          boundaryId: "compact_b",
          cacheUsage: { cacheReadTokens: 500 },
          createdAt: 2,
          lastSummarizedMessageId: "msg_b",
          messageId: "msg_b",
          postCompactTokenCount: 200,
          preCompactTokenCount: 2000,
          summarizedMessageCount: 6,
        },
      ],
      status: "success",
    });

    expect(text).toContain("input 1k (1/2 folds)");
    expect(text).toContain("cache read 500 (1/2 folds)");
    expect(text).toContain("cache write unavailable");
    expect(text).not.toContain("cache usage unavailable");
  });

  it("shows complete fold cost without coverage suffixes when every fold reports", () => {
    const text = render({
      ...baseOutput,
      ranges: [
        {
          boundaryId: "compact_a",
          cacheUsage: { cacheReadTokens: 100, cacheWriteTokens: 50, inputTokens: 1000 },
          createdAt: 1,
          messageId: "msg_a",
          summarizedMessageCount: 5,
        },
        {
          boundaryId: "compact_b",
          cacheUsage: { cacheReadTokens: 100, cacheWriteTokens: 50, inputTokens: 500 },
          createdAt: 2,
          messageId: "msg_b",
          summarizedMessageCount: 6,
        },
      ],
      status: "success",
    });

    expect(text).toContain("fold cost: input 1.5k · cache read 200 · cache write 100");
    expect(text).not.toContain("folds)");
  });
});
