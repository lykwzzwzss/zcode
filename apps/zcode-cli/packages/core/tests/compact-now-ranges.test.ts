import { describe, expect, it, vi } from "vitest";

import { compactNowHandler } from "../src/tool/handlers/compact-now.js";
import type { CompactControlPort, ToolExecutionContext } from "../src/tool/types.js";

function context(port?: CompactControlPort) {
  return { compactControlPort: port } as unknown as ToolExecutionContext;
}

const range = { startMessageId: "msg_start", endMessageId: "msg_end" };

describe("CompactNow handler range plumbing", () => {
  it("preserves the model-written summary through command admission", async () => {
    const requestCompact = vi.fn<CompactControlPort["requestCompact"]>(() => ({ accepted: true }));
    const ranges = [{ ...range, summary: "Keep the user's constraints and unfinished objective." }];
    await compactNowHandler({ ranges }, context({ requestCompact }));
    expect(requestCompact).toHaveBeenCalledWith(expect.objectContaining({ ranges }));
  });
  it("queues the default prefix fold when ranges are omitted", async () => {
    const requestCompact = vi.fn<CompactControlPort["requestCompact"]>(() => ({ accepted: true }));
    const output = await compactNowHandler(
      { instructions: "keep the failing test output", reason: "user_request" },
      context({ requestCompact }),
    );

    expect(requestCompact).toHaveBeenCalledWith({
      instructions: "keep the failing test output",
      reason: "user_request",
    });
    expect(output).toMatchObject({ status: "accepted" });
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
