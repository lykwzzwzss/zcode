import { describe, expect, it, vi } from "vitest";

import { compactNowHandler } from "../src/tool/handlers/compact-now.js";
import type { CompactControlPort, ToolExecutionContext } from "../src/tool/types.js";
import { systemReminderAttachmentEntry } from "../src/agent/message-history.js";
import {
  checkModelCompactPreparation,
  type ModelCompactPreparationSlot,
} from "../src/runtime/methods/compact-active-helpers.js";

function context(port?: CompactControlPort) {
  return { compactControlPort: port } as unknown as ToolExecutionContext;
}

const range = {
  startMessageId: "msg_start",
  endMessageId: "msg_end",
  summary: "Keep the objective.",
};

describe("CompactNow handler range plumbing", () => {
  it.each([true, false])("accepts only previously seen tool hook context (same=%s)", (same) => {
    const slot: ModelCompactPreparationSlot = {};
    const notice = systemReminderAttachmentEntry(
      "tool_hook_context",
      "PostToolUse:CompactNow: keep error",
    );
    const entries = [{ message: { role: "user" as const, content: "original" } }, notice];
    checkModelCompactPreparation({
      source: { slot },
      entries,
      ranges: [range],
      requirements: ["keep"],
    });
    const token = slot.current!.token;
    const repeated = systemReminderAttachmentEntry(
      "tool_hook_context",
      same ? notice.content : "changed",
    );
    const result = checkModelCompactPreparation({
      source: { slot, preparationToken: token },
      entries: [...entries, repeated],
      ranges: [range],
      requirements: ["keep"],
    });
    expect(result.accepted).toBe(same);
  });
  it("requires an exact one-use preparation for repeated hook instructions", () => {
    const slot: ModelCompactPreparationSlot = {};
    const entries = [{ message: { role: "user" as const, content: "original" } }];
    const requirements = ["Keep the secret-free exact error."];
    const first = checkModelCompactPreparation({
      source: { slot },
      entries,
      ranges: [range],
      requirements,
    });
    expect(first.accepted).toBe(false);
    const token = slot.current?.token;
    expect(token).toBeTruthy();
    expect(first.accepted ? "" : first.message).toContain(token);
    const retry = [
      ...entries,
      { message: { role: "assistant" as const, content: "" } },
      { message: { role: "tool" as const, toolName: "CompactNow", content: "queued" } },
    ];
    expect(
      checkModelCompactPreparation({
        source: { slot, preparationToken: token },
        entries: retry,
        ranges: [range],
        requirements,
      }),
    ).toEqual({ accepted: true });
    expect(
      checkModelCompactPreparation({
        source: { slot, preparationToken: token },
        entries: retry,
        ranges: [range],
        requirements,
      }).accepted,
    ).toBe(false);
  });
  it("resets the consecutive preparation limit after success, allowing long turns", () => {
    const slot: ModelCompactPreparationSlot = {};
    const entries = [{ message: { role: "user" as const, content: "original" } }];
    for (let index = 0; index < 5; index++) {
      const first = checkModelCompactPreparation({
        source: { slot },
        entries,
        ranges: [range],
        requirements: ["preserve"],
      });
      expect(first.accepted).toBe(false);
      const token = slot.current?.token;
      expect(token).toBeTruthy();
      expect(
        checkModelCompactPreparation({
          source: { slot, preparationToken: token },
          entries,
          ranges: [range],
          requirements: ["preserve"],
        }),
      ).toEqual({ accepted: true });
    }
  });
  it("bounds consecutive changes and rejects oversized hook requirements without truncating them", () => {
    const slot: ModelCompactPreparationSlot = {};
    const entries = [{ message: { role: "user" as const, content: "original" } }];
    for (let index = 0; index < 3; index++) {
      const response = checkModelCompactPreparation({
        source: { slot },
        entries,
        ranges: [range],
        requirements: [`requirement ${index}`],
      });
      expect(response.accepted).toBe(false);
      expect(slot.current?.token).toBeTruthy();
    }
    const blocked = checkModelCompactPreparation({
      source: { slot },
      entries,
      ranges: [range],
      requirements: ["changed again"],
    });
    expect(blocked).toMatchObject({
      accepted: false,
      message: expect.stringContaining("limit reached"),
    });
    expect(slot.current).toBeUndefined();
    const oversized = checkModelCompactPreparation({
      source: { slot: {} },
      entries,
      ranges: [range],
      requirements: ["x".repeat(24_001)],
    });
    expect(oversized).toMatchObject({
      accepted: false,
      message: expect.stringContaining("exceed"),
    });
  });
  it("does not accept a preparation token in a new turn", () => {
    const slot: ModelCompactPreparationSlot = {};
    const entries = [{ message: { role: "user" as const, content: "original" } }];
    checkModelCompactPreparation({
      source: { slot },
      entries,
      ranges: [range],
      requirements: ["keep"],
    });
    const token = slot.current!.token;
    const resumed = checkModelCompactPreparation({
      source: { slot: {}, preparationToken: token },
      entries,
      ranges: [range],
      requirements: ["keep"],
    });
    expect(resumed.accepted).toBe(false);
  });
  it.each(["history", "range", "new-user", "other-tool", "requirements"])(
    "invalidates preparation on %s",
    (change) => {
      const slot: ModelCompactPreparationSlot = {};
      const entries = [{ message: { role: "user" as const, content: "original" } }];
      checkModelCompactPreparation({
        source: { slot },
        entries,
        ranges: [range],
        requirements: ["first"],
      });
      const token = slot.current?.token;
      const later =
        change === "history"
          ? [{ message: { role: "user" as const, content: "changed" } }]
          : change === "new-user"
            ? [...entries, { message: { role: "user" as const, content: "new" } }]
            : change === "other-tool"
              ? [
                  ...entries,
                  {
                    message: {
                      role: "assistant" as const,
                      content: "",
                      toolCalls: [{ id: "t", name: "Bash", input: {} }],
                    },
                  },
                ]
              : entries;
      const result = checkModelCompactPreparation({
        source: { slot, preparationToken: token },
        entries: later,
        ranges: [change === "range" ? { ...range, endMessageId: "other" } : range],
        requirements: [change === "requirements" ? "second" : "first"],
      });
      expect(result.accepted).toBe(false);
      expect(slot.current?.token).not.toBe(token);
    },
  );
  it("preserves the model-written summary through command admission", async () => {
    const requestCompact = vi.fn<CompactControlPort["requestCompact"]>(() => ({ accepted: true }));
    const ranges = [{ ...range, summary: "Keep the user's constraints and unfinished objective." }];
    await compactNowHandler({ ranges }, context({ requestCompact }));
    expect(requestCompact).toHaveBeenCalledWith(expect.objectContaining({ ranges }));
  });
  it("rejects summaries beyond the batch budget before queueing", async () => {
    const requestCompact = vi.fn<CompactControlPort["requestCompact"]>(() => ({ accepted: true }));
    const result = await compactNowHandler(
      {
        ranges: [1, 2, 3].map((index) => ({
          startMessageId: `m${index}`,
          endMessageId: `m${index}`,
          summary: "x".repeat(16_001),
        })),
      },
      context({ requestCompact }),
    );
    expect(result).toMatchObject({ status: "rejected", reason: "summaries_too_large" });
    expect(requestCompact).not.toHaveBeenCalled();
  });
  it("rejects a model request without ranges before admission", async () => {
    const requestCompact = vi.fn<CompactControlPort["requestCompact"]>(() => ({ accepted: true }));
    expect(
      await compactNowHandler(
        { instructions: "keep the failing test output", reason: "user_request" },
        context({ requestCompact }),
      ),
    ).toMatchObject({ status: "rejected", reason: "invalid_ranges_or_summaries" });
    expect(requestCompact).not.toHaveBeenCalled();
  });

  it("forwards explicit ranges to the runtime instead of dropping them", async () => {
    const requestCompact = vi.fn<CompactControlPort["requestCompact"]>(() => ({ accepted: true }));
    const output = await compactNowHandler({ ranges: [range] }, context({ requestCompact }));

    // 关键回归：ranges 必须原样排队；执行侧若不支持必须整单拒绝，
    // 不能在这里静默退化成「折叠最旧前缀」。reason 未传时 handler 补默认值，
    // 所以这里断言完整调用参数而不是只断言 ranges 子集。
    expect(requestCompact).toHaveBeenCalledWith({
      instructions: undefined,
      ranges: [range],
      reason: "context_pressure",
    });
    expect(output).toMatchObject({ status: "accepted" });
  });

  it("reports the unavailable port before forwarding ranges", async () => {
    const output = await compactNowHandler({ ranges: [range] }, context(undefined));

    expect(output).toMatchObject({ reason: "port_unavailable", status: "rejected" });
  });
});
